import { describe, expect, spyOn, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { SessionProcessor } from "../../src/session/processor"
import { outputWatchdog } from "../../src/session/output-watchdog"

const encoder = new TextEncoder()
const context = { sessionID: "ses_watchdog", messageID: "msg_watchdog", attempt: 2 }

/** Advance the real watchdogs without spending minutes on a silent fixture.
 * Tests are serial and restore these process-local clocks in every finally. */
function clock() {
  const schedule = globalThis.setTimeout
  const cancel = globalThis.clearTimeout
  const origin = Date.now()
  let now = 0
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>()
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (run: TimerHandler, delay = 0, ...args: unknown[]) => {
        if (typeof run !== "function") throw new TypeError("The fixture clock only accepts function callbacks")
        const handle = schedule(() => {}, 2_147_483_647).unref()
        timers.set(handle, { at: now + delay, run: () => run(...args) })
        return handle
      },
      { __promisify__: schedule.__promisify__ },
      // Bun returns timer handles; the merged DOM overload also declares a number.
    ) as unknown as typeof setTimeout,
  )
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    timers.delete(handle as ReturnType<typeof setTimeout>)
    cancel(handle as ReturnType<typeof setTimeout>)
  })
  const date = spyOn(Date, "now").mockImplementation(() => origin + now)
  const performanceClock = spyOn(performance, "now").mockImplementation(() => now)
  return {
    async advance(milliseconds: number) {
      const target = now + milliseconds
      // ReadableStream pull jobs must enter their wait before the clock moves.
      await Bun.sleep(0)
      while (true) {
        const next = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        timers.delete(next[0])
        cancel(next[0])
        next[1].run()
        await Bun.sleep(0)
      }
      now = target
      await Bun.sleep(0)
    },
    restore() {
      for (const handle of timers.keys()) cancel(handle)
      timeout.mockRestore()
      clear.mockRestore()
      date.mockRestore()
      performanceClock.mockRestore()
    },
  }
}

type Settled<T> = { type: "resolved"; value: T } | { type: "rejected"; error: unknown } | { type: "hung" }

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<Settled<T>> {
  return Promise.race([
    promise.then(
      (value) => ({ type: "resolved" as const, value }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    ),
    Bun.sleep(timeoutMs).then(() => ({ type: "hung" as const })),
  ])
}

function watched(
  fetchFn: Parameters<typeof Provider.fetchWithIdleWatchdog>[0],
  options: Partial<Parameters<typeof Provider.fetchWithIdleWatchdog>[3]> = {},
  init?: BunFetchRequestInit,
) {
  const timings: Provider.RequestTiming[] = []
  const response = Provider.withRequestContext(context, () =>
    Provider.fetchWithIdleWatchdog(fetchFn, "https://provider.test/v1/responses", init, {
      providerID: "test-provider",
      modelID: "test-model",
      idleTimeout: 30,
      connectTimeout: options.idleTimeout ?? 30,
      ...options,
      onTiming: (timing) => {
        timings.push(timing)
        options.onTiming?.(timing)
      },
    }),
  )
  return { response, timings }
}

describe("provider activity watchdog", () => {
  test("never emits a funding credential through request timing", async () => {
    const secret = "thk_timing.super-secret"
    const timings: Provider.RequestTiming[] = []
    const response = Provider.withRequestContext(
      {
        ...context,
        funding: Object.freeze({
          api_key: secret,
          user_id: "user-timing",
          account: "user-timing",
          organization_id: "org-timing",
        }),
      },
      () =>
        Provider.fetchWithIdleWatchdog(async () => new Response("ok"), "https://provider.test", undefined, {
          providerID: "test-provider",
          modelID: "test-model",
          idleTimeout: false,
          onTiming: (timing) => timings.push(timing),
        }),
    )
    expect(await (await response).text()).toBe("ok")
    const serialized = JSON.stringify(timings)
    expect(timings).toHaveLength(1)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("api_key")
    expect(serialized).not.toContain("funding")
  })

  test("bounds headers by default but makes response inactivity limits opt-in", () => {
    expect(Provider.resolveConnectTimeout(undefined)).toBe(120_000)
    expect(Provider.resolveIdleTimeout(undefined)).toBe(false)
    expect(Provider.resolveOutputIdleTimeout(undefined)).toBe(false)
    expect(Provider.resolveConnectTimeout(false)).toBe(false)
    expect(Provider.resolveIdleTimeout(false)).toBe(false)
    expect(Provider.resolveOutputIdleTimeout(false)).toBe(false)
    expect(Provider.resolveIdleTimeout(12_345.9)).toBe(12_345)
    expect(Provider.resolveOutputIdleTimeout(600_000)).toBe(600_000)
    expect(Provider.resolveIdleTimeout(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647)
  })

  for (const partial of [false, true]) {
    test(`default quiet response resumes after fifteen minutes ${partial ? "after partial output" : "before first output"}`, async () => {
      const time = clock()
      const user = new AbortController()
      const transport = new AbortController()
      const watchdog = outputWatchdog({
        timeout: Provider.resolveOutputIdleTimeout(undefined),
        signal: user.signal,
        expire: () => new Provider.RequestTimeoutError("output", 600_000),
        onTimeout: (reason) => transport.abort(reason),
      })
      let source!: ReadableStreamDefaultController<Uint8Array>
      let signal: AbortSignal | undefined
      let requests = 0
      const timings: Provider.RequestTiming[] = []
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await Provider.withRequestContext({ ...context, abort: transport.signal }, () =>
          Provider.fetchWithIdleWatchdog(
            async (_input, init) => {
              requests++
              signal = init?.signal ?? undefined
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    source = controller
                    if (partial) controller.enqueue(encoder.encode("partial reasoning"))
                  },
                }),
              )
            },
            "https://provider.test/no-network",
            { signal: user.signal },
            { providerID: "test", modelID: "test", onTiming: (item) => timings.push(item) },
          ),
        )
        reader = response.body!.getReader()
        watchdog.start()
        if (partial) {
          expect(new TextDecoder().decode((await watchdog.next(() => reader!.read())).value)).toBe("partial reasoning")
          watchdog.progress()
        }
        let settled = false
        const pending = watchdog.next(() => reader!.read())
        void pending.then(
          () => (settled = true),
          () => (settled = true),
        )
        await time.advance(900_001)
        expect(settled).toBe(false)
        expect(signal?.aborted).toBe(false)
        expect(timings).toHaveLength(0)
        source.enqueue(encoder.encode("resumed output"))
        source.close()
        expect(new TextDecoder().decode((await pending).value)).toBe("resumed output")
        watchdog.progress()
        expect((await watchdog.next(() => reader!.read())).done).toBe(true)
        expect(requests).toBe(1)
        expect(timings).toHaveLength(1)
        expect(timings[0]).toMatchObject({ outcome: "completed", idleTimeoutMs: false, connectTimeoutMs: 120_000 })
        expect(timings[0].completedAt - timings[0].startedAt).toBeGreaterThan(900_000)
      } finally {
        user.abort(new DOMException("fixture cleanup", "AbortError"))
        await reader?.cancel().catch(() => {})
        watchdog.dispose()
        time.restore()
      }
    })
  }

  test("default quiet response still cancels its reader immediately when the user stops", async () => {
    const time = clock()
    const user = new AbortController()
    const reason = new DOMException("User stopped", "AbortError")
    let cancelled: unknown
    let signal: AbortSignal | undefined
    const { response, timings } = watched(
      async (_input, init) => {
        signal = init?.signal ?? undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel(value) {
              cancelled = value
            },
          }),
        )
      },
      { idleTimeout: undefined, connectTimeout: undefined },
      { signal: user.signal },
    )
    try {
      const body = (await response).text()
      void body.catch(() => {})
      await time.advance(900_001)
      expect(signal?.aborted).toBe(false)
      user.abort(reason)
      await expect(body).rejects.toBe(reason)
      expect(signal?.reason).toBe(reason)
      expect(cancelled).toBe(reason)
      expect(timings).toHaveLength(1)
      expect(timings[0]).toMatchObject({ outcome: "aborted", idleTimeoutMs: false })
    } finally {
      user.abort(reason)
      time.restore()
    }
  })

  for (const phase of ["stream", "output"] as const) {
    test(`an explicitly configured ${phase} deadline still aborts without making the paid outcome retryable`, async () => {
      const time = clock()
      const user = new AbortController()
      const transport = new AbortController()
      const duration = phase === "stream" ? 300_000 : 600_000
      const watchdog = outputWatchdog({
        timeout: Provider.resolveOutputIdleTimeout(phase === "output" ? duration : undefined),
        signal: user.signal,
        expire: () => new Provider.RequestTimeoutError("output", duration),
        onTimeout: (reason) => transport.abort(reason),
      })
      let requests = 0
      let cancelled: unknown
      let signal: AbortSignal | undefined
      try {
        const response = await Provider.withRequestContext({ ...context, abort: transport.signal }, () =>
          Provider.fetchWithIdleWatchdog(
            async (_input, init) => {
              requests++
              signal = init?.signal ?? undefined
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(encoder.encode("saved partial output"))
                  },
                  cancel(reason) {
                    cancelled = reason
                  },
                }),
              )
            },
            "https://provider.test/no-network",
            { signal: user.signal },
            { providerID: "test", modelID: "test", idleTimeout: phase === "stream" ? duration : undefined },
          ),
        )
        const reader = response.body!.getReader()
        watchdog.start()
        expect(new TextDecoder().decode((await watchdog.next(() => reader.read())).value)).toBe("saved partial output")
        watchdog.progress()
        const pending = watchdog.next(() => reader.read())
        void pending.catch(() => {})
        await time.advance(duration + 1)
        await expect(pending).rejects.toMatchObject({ phase, timeoutMs: duration })
        expect(signal?.aborted).toBe(true)
        expect(Provider.requestTimeout(cancelled)).toMatchObject({ phase, timeoutMs: duration })
        expect(SessionProcessor.retryableProviderError(cancelled, {} as never)).toBeUndefined()
        expect(requests).toBe(1)
      } finally {
        user.abort(new DOMException("fixture cleanup", "AbortError"))
        watchdog.dispose()
        time.restore()
      }
    })
  }

  test("provider timeout config separates total and idle contracts", () => {
    const parsed = Config.Provider.parse({
      options: { timeout: false, idleTimeout: 120_000, connectTimeout: 60_000, outputIdleTimeout: false },
    })
    expect(parsed.options?.timeout).toBe(false)
    expect(parsed.options?.idleTimeout).toBe(120_000)
    expect(parsed.options?.connectTimeout).toBe(60_000)
    expect(parsed.options?.outputIdleTimeout).toBe(false)
    expect(() => Config.Provider.parse({ options: { idleTimeout: 2_147_483_648 } })).toThrow()
    expect(() => Config.Provider.parse({ options: { timeout: 2_147_483_648 } })).toThrow()
    expect(() => Config.Provider.parse({ options: { connectTimeout: 0 } })).toThrow()
    expect(() => Config.Provider.parse({ options: { outputIdleTimeout: 2_147_483_648 } })).toThrow()
  })

  test("the default header deadline remains finite when fetch never responds", async () => {
    const time = clock()
    let signal: AbortSignal | undefined
    const { response, timings } = watched(
      async (_input, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      },
      { idleTimeout: undefined, connectTimeout: undefined },
    )
    void response.catch(() => {})
    try {
      await time.advance(120_001)
      await expect(response).rejects.toMatchObject({ phase: "connect", timeoutMs: 120_000 })
      expect(signal?.aborted).toBe(true)
      expect(timings).toHaveLength(1)
      expect(timings[0]).toMatchObject({ outcome: "idle_timeout", timeoutPhase: "connect", idleTimeoutMs: false })
    } finally {
      time.restore()
    }
  })

  test("uses a distinct header deadline and aborts the underlying fetch", async () => {
    let signal: AbortSignal | undefined
    const { response, timings } = watched(
      async (_input, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      },
      { connectTimeout: 20, idleTimeout: 200 },
    )
    const result = await settleWithin(response)
    expect(result.type).toBe("rejected")
    expect(signal?.aborted).toBe(true)
    expect(Provider.isRequestTimeoutError(signal?.reason)).toBe(true)
    expect(timings[0]).toMatchObject({ connectTimeoutMs: 20, idleTimeoutMs: 200, timeoutPhase: "connect" })
    expect(timings[0].completedAt - timings[0].startedAt).toBeLessThan(150)
  })

  test("does not apply the body-idle deadline while response headers are pending", async () => {
    const { response, timings } = watched(
      async () => {
        await Bun.sleep(30)
        return new Response("ok")
      },
      { connectTimeout: 100, idleTimeout: 10 },
    )
    expect(await (await response).text()).toBe("ok")
    expect(timings[0].outcome).toBe("completed")
    expect(timings[0].responseStartedAt! - timings[0].startedAt).toBeGreaterThanOrEqual(25)
  })

  test("provider-only cancellation closes HTTP while preserving the tool authority signal", async () => {
    const user = new AbortController()
    const provider = new AbortController()
    const error = new Provider.RequestTimeoutError("output", 600_000)
    let signal: AbortSignal | undefined
    const timings: Provider.RequestTiming[] = []
    const response = await Provider.withRequestContext({ ...context, abort: provider.signal }, () =>
      Provider.fetchWithIdleWatchdog(
        async (_input, init) => {
          signal = init?.signal ?? undefined
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode("saved partial output"))
              },
            }),
          )
        },
        "https://provider.test/no-network",
        { signal: user.signal },
        { providerID: "test-provider", modelID: "test-model", onTiming: (item) => timings.push(item) },
      ),
    )
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("saved partial output")
    const pending = reader.read()
    provider.abort(error)
    expect(await settleWithin(pending)).toEqual({ type: "rejected", error })
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBe(error)
    expect(user.signal.aborted).toBe(false)
    expect(timings[0]).toMatchObject({
      outcome: "timeout",
      timeoutPhase: "output",
      errorName: "ProviderRequestTimeoutError",
    })
  })

  test("recognizes all timeout kinds through SDK wrappers without classifying unrelated errors", () => {
    for (const phase of ["connect", "first_event", "stream", "output", "total"] as const) {
      const error = new Provider.RequestTimeoutError(phase, 100)
      const wrapped = new Error("SDK wrapper", { cause: error })
      expect(Provider.isRequestTimeoutError(wrapped)).toBe(true)
      expect(Provider.requestTimeout(wrapped)).toBe(error)
      expect(Provider.isRequestTimeoutError(new AggregateError([{ name: error.name, phase, timeoutMs: 100 }]))).toBe(
        true,
      )
    }
    expect(Provider.isRequestTimeoutError(new Error("unrelated"))).toBe(false)
    expect(
      Provider.isRequestTimeoutError({ name: "ProviderRequestTimeoutError", phase: "invalid", timeoutMs: 100 }),
    ).toBe(false)
  })

  test("hard-returns when connection setup is silent even if fetch ignores abort", async () => {
    let signal: AbortSignal | undefined
    const { response, timings } = watched(
      async (_input, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      },
      { idleTimeout: 20 },
    )

    const settled = await settleWithin(response)
    expect(settled.type).toBe("rejected")
    if (settled.type !== "rejected") return
    expect(settled.error).toBeInstanceOf(Provider.IdleTimeoutError)
    expect((settled.error as Provider.IdleTimeoutError).phase).toBe("connect")
    expect(signal?.aborted).toBe(true)
    expect(timings).toHaveLength(1)
    expect(timings[0]).toMatchObject({
      ...context,
      providerID: "test-provider",
      modelID: "test-model",
      idleTimeoutMs: 20,
      outcome: "idle_timeout",
      timeoutPhase: "connect",
      errorName: "ProviderIdleTimeoutError",
    })
    expect(timings[0].responseStartedAt).toBeUndefined()
    expect(timings[0].firstBodyChunkAt).toBeUndefined()
    expect(timings[0].completedAt).toBeGreaterThanOrEqual(timings[0].startedAt)
  })

  test("labels silence before the first body chunk", async () => {
    const { response, timings } = watched(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
          }),
        ),
      { idleTimeout: 20 },
    )

    const result = await settleWithin(response.then((value) => value.text()))
    expect(result.type).toBe("rejected")
    if (result.type !== "rejected") return
    expect(result.error).toBeInstanceOf(Provider.IdleTimeoutError)
    expect((result.error as Provider.IdleTimeoutError).phase).toBe("first_event")
    expect(timings).toHaveLength(1)
    expect(timings[0].timeoutPhase).toBe("first_event")
    expect(timings[0].responseStartedAt).toBeDefined()
    expect(timings[0].firstBodyChunkAt).toBeUndefined()
  })

  test("labels mid-body silence and records first/last activity", async () => {
    let sent = false
    const { response, timings } = watched(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true
                controller.enqueue(encoder.encode("first"))
                return
              }
              return new Promise<void>(() => {})
            },
          }),
        ),
      { idleTimeout: 20 },
    )

    const result = await settleWithin(response.then((value) => value.text()))
    expect(result.type).toBe("rejected")
    if (result.type !== "rejected") return
    expect(result.error).toBeInstanceOf(Provider.IdleTimeoutError)
    expect((result.error as Provider.IdleTimeoutError).phase).toBe("stream")
    expect(timings).toHaveLength(1)
    expect(timings[0].timeoutPhase).toBe("stream")
    expect(timings[0].firstBodyChunkAt).toBeDefined()
    expect(timings[0].lastBodyChunkAt).toBe(timings[0].firstBodyChunkAt)
  })

  test("allows an active stream to run for multiple idle windows", async () => {
    let index = 0
    const chunks = 8
    const idleTimeout = 500
    const { response, timings } = watched(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (index === chunks) {
                controller.close()
                return
              }
              await Bun.sleep(75)
              controller.enqueue(encoder.encode(String(index++)))
            },
          }),
        ),
      { idleTimeout },
    )

    expect(await response.then((value) => value.text())).toBe("01234567")
    expect(timings).toHaveLength(1)
    const timing = timings[0]
    expect(timing.outcome).toBe("completed")
    expect(timing.completedAt - timing.startedAt).toBeGreaterThan(idleTimeout)
    expect(timing.responseStartedAt).toBeGreaterThanOrEqual(timing.startedAt)
    expect(timing.firstBodyChunkAt).toBeGreaterThanOrEqual(timing.responseStartedAt!)
    expect(timing.lastBodyChunkAt).toBeGreaterThan(timing.firstBodyChunkAt!)
    expect(timing.completedAt).toBeGreaterThanOrEqual(timing.lastBodyChunkAt!)
  })

  test("preserves explicit caller abort instead of relabeling it idle", async () => {
    const controller = new AbortController()
    const reason = new DOMException("user stopped", "AbortError")
    const { response, timings } = watched(
      async () => new Promise<Response>(() => {}),
      { idleTimeout: 500 },
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(reason), 10)

    const settled = await settleWithin(response)
    expect(settled.type).toBe("rejected")
    if (settled.type !== "rejected") return
    expect(settled.error).toBe(reason)
    expect(timings).toHaveLength(1)
    expect(timings[0].outcome).toBe("aborted")
    expect(timings[0].timeoutPhase).toBeUndefined()
  })

  test("explicitly disabled header and body deadlines retain caller cancellation", async () => {
    const controller = new AbortController()
    const reason = new DOMException("cancel disabled-idle request", "AbortError")
    const { response, timings } = watched(
      async () => new Promise<Response>(() => {}),
      { idleTimeout: false, connectTimeout: false },
      { signal: controller.signal },
    )

    const early = await Promise.race([
      response.then(
        () => "settled",
        () => "settled",
      ),
      Bun.sleep(40).then(() => "pending"),
    ])
    expect(early).toBe("pending")
    controller.abort(reason)
    const settled = await settleWithin(response)
    expect(settled.type).toBe("rejected")
    if (settled.type !== "rejected") return
    expect(settled.error).toBe(reason)
    expect(timings).toHaveLength(1)
    expect(timings[0]).toMatchObject({ idleTimeoutMs: false, connectTimeoutMs: false, outcome: "aborted" })
  })

  test("honors an explicit total timeout even while the body stays active", async () => {
    let index = 0
    const { response, timings } = watched(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Bun.sleep(8)
              controller.enqueue(encoder.encode(String(index++)))
            },
          }),
        ),
      { idleTimeout: 100, totalTimeout: 45 },
    )

    const settled = await settleWithin(response.then((value) => value.text()))
    expect(settled.type).toBe("rejected")
    if (settled.type !== "rejected") return
    expect(Provider.requestTimeout(settled.error)).toMatchObject({ phase: "total", timeoutMs: 45 })
    expect(timings).toHaveLength(1)
    expect(timings[0]).toMatchObject({ outcome: "timeout", timeoutPhase: "total" })
    expect(timings[0].firstBodyChunkAt).toBeDefined()
  })

  test("body cancellation returns even when the upstream source ignores cancel", async () => {
    const { response, timings } = watched(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
            cancel: () => new Promise<void>(() => {}),
          }),
        ),
    )
    const body = (await response).body!
    const reader = body.getReader()
    void reader.read().catch(() => {})
    await Promise.resolve()

    const settled = await settleWithin(reader.cancel("consumer stopped"), 150)
    expect(settled.type).toBe("resolved")
    expect(timings).toHaveLength(1)
    expect(timings[0].outcome).toBe("cancelled")
  })

  test("an idle timeout is terminal even through stable-name and cause wrappers", () => {
    const original = new Provider.IdleTimeoutError("stream", 300_000)
    const wrapped = new Error("SDK stream failed", { cause: original })
    const serializedShape = {
      name: "ProviderIdleTimeoutError",
      phase: "connect",
      idleTimeoutMs: 300_000,
    }
    expect(Provider.isIdleTimeoutError(wrapped)).toBe(true)
    expect(Provider.isIdleTimeoutError(new AggregateError([serializedShape], "adapter failed"))).toBe(true)
    expect(SessionProcessor.retryableProviderError(wrapped, {} as never)).toBeUndefined()
  })

  test("passes through status-zero responses without trying to clone them", async () => {
    const original = Response.error()
    const { response, timings } = watched(async () => original)
    expect(await response).toBe(original)
    expect(timings).toHaveLength(1)
    expect(timings[0].outcome).toBe("completed")
  })
})
