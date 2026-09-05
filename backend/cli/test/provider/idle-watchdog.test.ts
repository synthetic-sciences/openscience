import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { SessionProcessor } from "../../src/session/processor"

const encoder = new TextEncoder()
const context = { sessionID: "ses_watchdog", messageID: "msg_watchdog", attempt: 2 }

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

  test("bounds silent request stages by default and preserves explicit escape hatches", () => {
    expect(Provider.resolveConnectTimeout(undefined)).toBe(120_000)
    expect(Provider.resolveIdleTimeout(undefined)).toBe(300_000)
    expect(Provider.resolveOutputIdleTimeout(undefined)).toBe(600_000)
    expect(Provider.resolveConnectTimeout(false)).toBe(false)
    expect(Provider.resolveIdleTimeout(false)).toBe(false)
    expect(Provider.resolveOutputIdleTimeout(false)).toBe(false)
    expect(Provider.resolveIdleTimeout(12_345.9)).toBe(12_345)
    expect(Provider.resolveIdleTimeout(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647)
  })

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
