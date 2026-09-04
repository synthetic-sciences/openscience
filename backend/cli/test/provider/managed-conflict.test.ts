import { describe, expect, test } from "bun:test"
import { APICallError, generateText } from "ai"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import { OpenScience } from "../../src/openscience"
import { Instance } from "../../src/project/instance"
import { MANAGED_MODEL_DETAILS, MANAGED_OPENROUTER_MODELS } from "../../src/provider/managed-catalog"
import { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { SessionTelemetry } from "../../src/session/telemetry"
import { tmpdir } from "../fixture/fixture"

const organization = "org_conflict"
const funding = {
  "OpenScience-Funding-Protocol": "1",
  "OpenScience-Funding-Context": `organization:${organization}`,
}
const catalog = MANAGED_OPENROUTER_MODELS.map((id) => ({
  id,
  upstream_provider: id.startsWith("anthropic/")
    ? "anthropic"
    : id.startsWith("google/")
      ? "gemini"
      : id.startsWith("x-ai/")
        ? "xai"
        : id.startsWith("meta/")
          ? "meta"
          : "openrouter",
  context_length: MANAGED_MODEL_DETAILS[id].context,
  max_output_tokens: MANAGED_MODEL_DETAILS[id].output,
  pricing: { tiers: [{ input: 2, output: 6 }] },
}))

const progress = () =>
  Response.json({ error: "operation_in_progress" }, { status: 409, headers: { "retry-after": "1" } })
const replay = () =>
  Response.json(
    {
      id: "chat_fixture",
      created: 1,
      model: "openai/gpt-5.6-sol",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
    { headers: { ...funding, "x-openscience-idempotent-replay": "true" } },
  )
const conflict = () =>
  Response.json(
    {
      detail: {
        code: "idempotency_conflict",
        message: "Idempotency-Key was already used with a different request body",
      },
    },
    { status: 409, headers: { "retry-after": "1" } },
  )
const sealed = () =>
  Response.json(
    {
      detail: {
        code: "idempotent_stream_already_started",
        message: "The original managed stream was already started and cannot be dispatched twice",
      },
    },
    { status: 409, headers: { "x-openscience-idempotent-replay": "true" } },
  )
/** The current gateway answers a sealed key with 410 and no replay header. */
const gone = (code = "idempotent_stream_already_started") =>
  Response.json(
    { detail: { code, message: "The original managed stream was already started and cannot be dispatched twice" } },
    { status: 410 },
  )
const unknown = (status: 409 | 410) =>
  Response.json(
    {
      detail: {
        code: "managed_outcome_unknown",
        message: "The provider outcome is unknown and this request cannot be dispatched twice",
      },
    },
    { status, headers: status === 409 ? { "x-openscience-idempotent-replay": "true" } : {} },
  )
const upstream = () =>
  Response.json({ error: { message: "upstream conflict", code: "temporary_conflict" } }, { status: 409 })

type Seen = { key: string | null; body: string }

/** A real gateway whose chat completions follow a scripted response sequence. */
function gateway(script: Array<() => Response>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/model-catalog")) return Response.json({ models: catalog }, { headers: funding })
      if (!url.pathname.endsWith("/chat/completions")) return Response.json({}, { headers: funding })
      seen.push({ key: request.headers.get("Idempotency-Key"), body: await request.text() })
      const next = script.shift()
      if (!next) return Response.json({ error: "fixture script exhausted" }, { status: 500 })
      return next()
    },
  })
  return {
    server,
    seen,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

const context = { sessionID: "ses_conflict", messageID: "msg_conflict", attempt: 1, agent: "research" }

async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for request progress events")
    await Bun.sleep(10)
  }
}

function settle(
  server: ReturnType<typeof Bun.serve>,
  input: { managed?: boolean; signal?: AbortSignal; limitMs?: number; context?: Provider.RequestContext } = {},
) {
  const headers = new Headers({ "content-type": "application/json", "Idempotency-Key": "os_fixture" })
  const init = {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "openai/gpt-5.6-sol", messages: [] }),
    signal: input.signal,
  }
  const url = new URL("/api/llm/proxy/openrouter/v1/chat/completions", server.url).href
  const request = () => fetch(url, init)
  const timings: Provider.RequestTiming[] = []
  const started = Date.now()
  const response = Provider.withRequestContext(input.context ?? context, () =>
    request().then((first) =>
      Provider.retryManagedConflict({
        response: first,
        managed: input.managed ?? true,
        headers,
        signal: input.signal,
        retry: request,
        timing: { providerID: "openrouter", modelID: "openai/gpt-5.6-sol", idleTimeoutMs: false },
        onTiming: (timing) => timings.push(timing),
        limitMs: input.limitMs,
      }),
    ),
  )
  return { response, timings, elapsed: () => Date.now() - started }
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(APICallError.isInstance(error)).toBe(true)
  return error as APICallError
}

describe("managed conflict guard", () => {
  test("waits for the gateway's original request and returns its replay", async () => {
    using fixture = gateway([progress, replay])
    const { response, timings, elapsed } = settle(fixture.server)
    const result = await response
    expect(result.status).toBe(200)
    expect(result.headers.get("x-openscience-idempotent-replay")).toBe("true")
    expect(((await result.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe(
      "ok",
    )
    expect(elapsed()).toBeGreaterThanOrEqual(1000)
    expect(fixture.seen).toHaveLength(2)
    expect(fixture.seen[1]).toEqual(fixture.seen[0])
    expect(fixture.seen[0].key).toBe("os_fixture")
    expect(timings).toHaveLength(1)
    expect(timings[0]).toMatchObject({
      ...context,
      providerID: "openrouter",
      modelID: "openai/gpt-5.6-sol",
      idleTimeoutMs: false,
      outcome: "conflict_wait",
      conflict: { code: "operation_in_progress", retries: 0, delayMs: 1000 },
    })
    expect(timings[0].conflict!.elapsedMs).toBeLessThan(1000)
  })

  test("surfaces a different-body key conflict immediately as non-retryable", async () => {
    using fixture = gateway([conflict])
    const { response, timings, elapsed } = settle(fixture.server)
    const error = await failure(response)
    expect(elapsed()).toBeLessThan(500)
    expect(fixture.seen).toHaveLength(1)
    expect(timings).toHaveLength(0)
    expect(error.statusCode).toBe(409)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toBe("Idempotency-Key was already used with a different request body")
    expect(error.responseBody).toContain("idempotency_conflict")
    expect(SessionRetry.retryable(MessageV2.fromError(error, { providerID: "openrouter" }))).toBeUndefined()
  })

  test("surfaces a sealed replay immediately instead of polling a key that can never succeed", async () => {
    using fixture = gateway([sealed])
    const { response, elapsed } = settle(fixture.server)
    const error = await failure(response)
    expect(elapsed()).toBeLessThan(500)
    expect(fixture.seen).toHaveLength(1)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toBe("The original managed stream was already started and cannot be dispatched twice")
    expect(error.responseHeaders?.["x-openscience-idempotent-replay"]).toBe("true")
    expect(SessionRetry.retryable(MessageV2.fromError(error, { providerID: "openrouter" }))).toBeUndefined()
  })

  test("keeps the idempotency key stable across attempts and distinct per body and message", () => {
    const base = {
      endpoint: "https://gateway.test/api/llm/proxy/openrouter/v1/chat/completions",
      body: JSON.stringify({ model: "openai/gpt-5.6-sol", messages: [] }),
      sessionID: "ses_key",
      messageID: "msg_key",
      operation: "model",
    }
    const first = Provider.managedIdempotencyKey(base)
    expect(first).toMatch(/^os_[0-9a-f]{64}$/)
    expect(Provider.managedIdempotencyKey({ ...base })).toBe(first)
    expect(Provider.managedIdempotencyKey({ ...base, body: JSON.stringify({ model: "x", messages: [] }) })).not.toBe(
      first,
    )
    expect(Provider.managedIdempotencyKey({ ...base, messageID: "msg_other" })).not.toBe(first)
    expect(Provider.managedIdempotencyKey({ ...base, sessionID: "ses_other" })).not.toBe(first)
    expect(Provider.managedIdempotencyKey({ ...base, operation: "title" })).not.toBe(first)
  })

  test.each([
    ["409 with the replay header", sealed, 409],
    ["410 stream already started", () => gone(), 410],
    ["410 response not replayable", () => gone("idempotent_response_not_replayable"), 410],
  ])("ends the attempt on an already-dispatched verdict (%s) without re-sending", async (_, verdict, status) => {
    using fixture = gateway([verdict])
    const { response, timings, elapsed } = settle(fixture.server)
    const error = await failure(response)
    expect(elapsed()).toBeLessThan(500)
    expect(fixture.seen).toHaveLength(1)
    expect(timings).toHaveLength(0)
    expect(error.statusCode).toBe(status)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toBe("The original managed stream was already started and cannot be dispatched twice")
    const normalized = MessageV2.fromError(error, { providerID: "openrouter" })
    expect(SessionRetry.retryable(normalized)).toBeUndefined()
    expect(SessionProcessor.providerFailureAction(error, normalized, false)).toEqual({ type: "terminal" })
    expect(SessionProcessor.providerFailureAction(error, normalized, true)).toEqual({ type: "terminal" })
    const shown = SessionRetry.terminal(normalized) as MessageV2.APIError
    expect(shown.data.message).toContain("billed again")
    expect(shown.data.isRetryable).toBe(false)
    expect(SessionRetry.retryable(shown)).toBeUndefined()
  })

  test.each([409, 410] as const)("never re-sends a managed_outcome_unknown verdict (%d)", async (status) => {
    using fixture = gateway([() => unknown(status)])
    const { response, timings, elapsed } = settle(fixture.server)
    const error = await failure(response)
    expect(elapsed()).toBeLessThan(500)
    expect(fixture.seen).toHaveLength(1)
    expect(timings).toHaveLength(0)
    expect(error.statusCode).toBe(status)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toBe("The provider outcome is unknown and this request cannot be dispatched twice")
    const normalized = MessageV2.fromError(error, { providerID: "openrouter" })
    expect(SessionRetry.retryable(normalized)).toBeUndefined()
    const shown = SessionRetry.terminal(normalized)
    expect(shown).not.toBe(normalized)
    expect((shown as MessageV2.APIError).data.message).toContain("billed again")
    expect(SessionProcessor.providerFailureAction(error, normalized, false)).toEqual({ type: "terminal" })
  })

  test("backs off exponentially and gives up with managed_conflict_timeout at the wait cap", async () => {
    using fixture = gateway([progress, progress, progress, progress])
    const { response, timings, elapsed } = settle(fixture.server, { limitMs: 3200 })
    const error = await failure(response)
    expect(elapsed()).toBeGreaterThanOrEqual(3200)
    expect(fixture.seen).toHaveLength(4)
    expect(new Set(fixture.seen.map((item) => item.key + item.body)).size).toBe(1)
    // The third wait is bounded by whatever remains of the cap: nominally 200ms
    // minus timer drift, never the 4000ms the doubling alone would give.
    const delays = timings.map((timing) => timing.conflict!.delayMs)
    expect(delays.slice(0, 2)).toEqual([1000, 2000])
    expect(delays[2]).toBeGreaterThan(0)
    expect(delays[2]).toBeLessThanOrEqual(200)
    expect(timings.map((timing) => timing.conflict!.retries)).toEqual([0, 1, 2])
    expect(timings[2].conflict!.elapsedMs).toBeGreaterThanOrEqual(3000)
    expect(error.statusCode).toBe(409)
    expect(error.isRetryable).toBe(false)
    expect(JSON.parse(error.responseBody!)).toMatchObject({
      error: "operation_in_progress",
      detail: { code: "managed_conflict_timeout" },
    })
    expect(error.message).toContain("after 4 seconds")
    expect(SessionRetry.retryable(MessageV2.fromError(error, { providerID: "openrouter" }))).toBeUndefined()
  })

  test("honours the caller's abort signal while waiting", async () => {
    using fixture = gateway([progress, progress])
    const controller = new AbortController()
    const reason = new DOMException("user stopped", "AbortError")
    const { response, elapsed } = settle(fixture.server, { signal: controller.signal })
    setTimeout(() => controller.abort(reason), 100)
    const error = await response.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBe(reason)
    expect(elapsed()).toBeLessThan(900)
    expect(fixture.seen).toHaveLength(1)
  })

  test("passes an unrelated upstream 409 through untouched", async () => {
    using fixture = gateway([upstream])
    const { response, timings } = settle(fixture.server)
    const result = await response
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ error: { message: "upstream conflict", code: "temporary_conflict" } })
    expect(fixture.seen).toHaveLength(1)
    expect(timings).toHaveLength(0)
  })

  test("only guards managed requests", async () => {
    using fixture = gateway([progress])
    const { response } = settle(fixture.server, { managed: false })
    expect((await response).status).toBe(409)
    expect(fixture.seen).toHaveLength(1)
  })

  test("the AI SDK never sees an in-progress 409 and never re-sends a sealed key", async () => {
    using fixture = gateway([progress, replay, sealed, gone, gone])
    const base = process.env["OPENSCIENCE_API_BASE"]
    process.env["OPENSCIENCE_API_BASE"] = fixture.server.url.origin
    try {
      await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
      await OpenScience.saveSession({
        api_key: "osk_fixture_conflict",
        user_id: "fixture",
        organization_id: organization,
        workspace_locked: true,
      })
      const refreshed = new Promise<void>((resolve) => {
        const listener = (event: { payload: { type: string } }) => {
          if (event.payload.type !== "global.disposed") return
          GlobalBus.off("event", listener)
          resolve()
        }
        GlobalBus.on("event", listener)
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Provider.list()
          await refreshed
          const model = (await Provider.list()).openrouter.models["openai/gpt-5.6-sol"]
          expect(model.api.url).toStartWith(fixture.server.url.origin)
          const language = await Provider.getLanguage(model)
          const scope = { ...context, modelID: model.id }

          const result = await Provider.withRequestContext(scope, () =>
            generateText({ model: language, prompt: "Hi", maxRetries: 0 }),
          )
          expect(result.text).toBe("ok")
          expect(fixture.seen).toHaveLength(2)
          expect(fixture.seen[0].key).toStartWith("os_")
          expect(fixture.seen[1]).toEqual(fixture.seen[0])

          const error = await failure(
            Provider.withRequestContext({ ...scope, messageID: "msg_sealed" }, () =>
              generateText({ model: language, prompt: "Hi", maxRetries: 2 }),
            ),
          )
          expect(fixture.seen).toHaveLength(3)
          expect(error.statusCode).toBe(409)
          expect(error.isRetryable).toBe(false)
          expect(error.message).toBe("The original managed stream was already started and cannot be dispatched twice")
          expect(SessionRetry.retryable(MessageV2.fromError(error, { providerID: "openrouter" }))).toBeUndefined()

          // A 410 is final at the SDK layer (one request despite maxRetries: 2)
          // and at the session layer: the verdict is terminal, and a later
          // attempt of the same body carries the same key, so the gateway's
          // sealed claim still answers it instead of a second inference.
          const dispatch = async (attempt: number) => {
            const gone = await failure(
              Provider.withRequestContext({ ...scope, messageID: "msg_gone", attempt }, () =>
                generateText({ model: language, prompt: "Hi", maxRetries: 2 }),
              ),
            )
            expect(gone.statusCode).toBe(410)
            expect(gone.isRetryable).toBe(false)
            const normalized = MessageV2.fromError(gone, { providerID: "openrouter" })
            expect(SessionProcessor.providerFailureAction(gone, normalized, false)).toEqual({ type: "terminal" })
            expect((SessionRetry.terminal(normalized) as MessageV2.APIError).data.message).toContain("billed again")
          }
          await dispatch(1)
          expect(fixture.seen).toHaveLength(4)
          expect(fixture.seen[3].key).toStartWith("os_")
          await dispatch(2)
          expect(fixture.seen).toHaveLength(5)
          expect(fixture.seen[4]).toEqual(fixture.seen[3])
        },
      })
    } finally {
      if (base === undefined) delete process.env["OPENSCIENCE_API_BASE"]
      if (base !== undefined) process.env["OPENSCIENCE_API_BASE"] = base
      await OpenScience.clearSession()
    }
  })
})

describe("conflict wait telemetry", () => {
  test("a conflict wait publishes session.request.progress with phase conflict_wait for the in-flight message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: SessionTelemetry.RequestProgress[] = []
        Bus.subscribe(SessionTelemetry.Event.Progress, (event) => seen.push(event.properties))
        // The processor records "connecting" before the provider fetch starts.
        SessionTelemetry.recordProgress({
          ...context,
          providerID: "openrouter",
          modelID: "openai/gpt-5.6-sol",
          phase: "connecting",
        })
        using fixture = gateway([progress, replay])
        const { response, timings } = settle(fixture.server)
        expect((await response).status).toBe(200)
        expect(timings).toHaveLength(1)
        await until(() => seen.length >= 2)
        expect(seen.map((item) => item.phase)).toEqual(["connecting", "conflict_wait"])
        expect(seen[1]).toMatchObject({
          sessionID: context.sessionID,
          messageID: context.messageID,
          attempt: 1,
          agent: "research",
          providerID: "openrouter",
          modelID: "openai/gpt-5.6-sol",
          retryAfterMs: 1000,
          detail: "operation_in_progress",
          stalls: 1,
        })
        // Recorded when the wait starts, not after it.
        expect(seen[1].elapsedMs).toBeLessThan(1000)
        expect(SessionTelemetry.progress(context.sessionID)).toEqual(seen[1])

        // A background request for another message (a title stream) waiting on
        // the gateway never replaces the visible turn's phase.
        using other = gateway([progress, replay])
        const background = settle(other.server, { context: { ...context, messageID: "summary:msg_conflict" } })
        expect((await background.response).status).toBe(200)
        expect(background.timings).toHaveLength(1)
        await Bun.sleep(20)
        expect(seen).toHaveLength(2)
        SessionTelemetry.recordProgress({ ...context, phase: "done" })
      },
    })
  })
})

describe("request timing attribution", () => {
  const body = (model?: string) => JSON.stringify(model ? { model, messages: [] } : { messages: [] })

  async function timed(init: BunFetchRequestInit, scope?: Provider.RequestContext) {
    const timings: Provider.RequestTiming[] = []
    const run = () =>
      Provider.fetchWithIdleWatchdog(
        async () => new Response("ok"),
        "https://provider.test/v1/chat/completions",
        init,
        {
          providerID: "openrouter",
          modelID: "anthropic/claude-haiku-4.5",
          idleTimeout: false,
          onTiming: (timing) => timings.push(timing),
        },
      )
    const response = scope ? await Provider.withRequestContext(scope, run) : await run()
    await response.text()
    expect(timings).toHaveLength(1)
    return timings[0]
  }

  test("stamps each request with the model from its own body when models share one SDK instance", async () => {
    const scope = {
      sessionID: "ses_attr",
      messageID: "msg_attr",
      attempt: 2,
      agent: "research",
      modelID: "openai/gpt-5.6-sol",
    }
    const sol = await timed({ method: "POST", body: body("openai/gpt-5.6-sol") }, scope)
    const title = await timed(
      { method: "POST", body: body("anthropic/claude-haiku-4.5") },
      { ...scope, agent: "title", modelID: "anthropic/claude-haiku-4.5" },
    )
    expect(sol).toMatchObject({
      sessionID: "ses_attr",
      messageID: "msg_attr",
      attempt: 2,
      agent: "research",
      providerID: "openrouter",
      modelID: "openai/gpt-5.6-sol",
      outcome: "completed",
    })
    expect(title).toMatchObject({ agent: "title", modelID: "anthropic/claude-haiku-4.5" })
  })

  test("falls back to the session model, then to the SDK closure model", async () => {
    const scope = { sessionID: "ses_attr", messageID: "msg_attr", attempt: 1, modelID: "openai/gpt-5.6-sol" }
    expect((await timed({ method: "POST", body: body() }, scope)).modelID).toBe("openai/gpt-5.6-sol")
    const bare = await timed({ method: "POST", body: body() })
    expect(bare.modelID).toBe("anthropic/claude-haiku-4.5")
    expect(bare.agent).toBeUndefined()
    expect(bare.sessionID).toBe("unknown")
  })

  test("reads a model field that is not first in the body without trusting message content", async () => {
    const late = JSON.stringify({ messages: [{ role: "user", content: '{"model":"decoy"}' }], model: "x-ai/grok-4.6" })
    expect((await timed({ method: "POST", body: late })).modelID).toBe("x-ai/grok-4.6")
  })
})
