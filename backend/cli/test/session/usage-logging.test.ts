import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { LanguageModelUsage } from "ai"
import { Global } from "../../src/global"
import { UsageLogging } from "../../src/session/usage-logging"
import { UsageLoggingRoutes } from "../../src/server/routes/settings/usage-logging"
import { LLM } from "../../src/session/llm"
import { Session } from "../../src/session"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { tmpdir, trustProject } from "../fixture/fixture"
import { stressProviderConfig } from "../fixture/stress-provider"
import { tracePayload } from "../../src/session/trace-payload"

const store = path.join(Global.Path.data, "usage-logging.json")
const session = path.join(Global.Path.data, "openscience-session.json")
const consent = path.join(Global.Path.data, "telemetry-consent-v2.json")
const version = "openscience-trace-v3-2026-08-26"
const token = "thk_0123456789abcdef0123456789abcdef.fixture-credential-for-local-test"
const previous = process.env.OPENSCIENCE_API_BASE
const measured: LanguageModelUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  totalTokens: 1_200,
  reasoningTokens: 50,
  cachedInputTokens: 400,
}

type Batch = {
  delivery_id: string
  installation_id: string
  events: Array<{
    event_id: string
    event_type: string
    span_id: string
    parent_span_id?: string
    model_route: string
    payload: Record<string, unknown>
  }>
}

function receiver(
  options: {
    enabled?: boolean
    owned?: boolean
    respond?: (batch: Batch, pass: number) => Response | Promise<Response>
  } = {},
) {
  const batches: Batch[] = []
  const requests: string[] = []
  const received = new Map<string, Batch["events"][number]>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
      requests.push(new URL(request.url).pathname)
      if (new URL(request.url).pathname.endsWith("/consent"))
        return Response.json({
          consent_version: version,
          analytics_enabled: options.enabled ?? true,
          research_content_enabled: options.enabled ?? true,
          user_owned_content_enabled: options.owned ?? true,
        })
      expect(request.headers.get("content-encoding")).toBe("gzip")
      const batch: Batch = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await request.arrayBuffer())))
      batches.push(batch)
      const replayed = batch.events.filter((event) => received.has(event.event_id)).map((event) => event.event_id)
      for (const event of batch.events) received.set(event.event_id, event)
      if (options.respond) return options.respond(batch, batches.length)
      return Response.json({
        delivery_id: batch.delivery_id,
        schema_version: 2,
        consent_version: version,
        accepted: batch.events.map((event) => event.event_id).filter((id) => !replayed.includes(id)),
        replayed,
        rejected: [],
      })
    },
  })
  process.env.OPENSCIENCE_API_BASE = server.url.toString()
  return { batches, received, requests, [Symbol.dispose]: () => server.stop(true) }
}

async function signedIn(user = "usage-user") {
  await Bun.write(session, JSON.stringify({ api_key: token, user_id: user }))
}

async function record(route = "managed") {
  const context = await UsageLogging.context()
  if (!context) throw new Error("fixture account is not signed in")
  await UsageLogging.record({
    context,
    sessionID: "ses_private-project-name",
    messageID: "msg_private-conversation",
    route,
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    usage: measured,
    metadata: { openrouter: { usage: { cost: 0.0123456789 } } },
    duration: 125,
  })
}

beforeEach(async () => {
  await UsageLogging.drain()
  for (const file of [store, session, consent])
    await Bun.file(file)
      .delete()
      .catch(() => undefined)
})

afterEach(async () => {
  await UsageLogging.drain()
  for (const file of [store, session, consent])
    await Bun.file(file)
      .delete()
      .catch(() => undefined)
  process.env.OPENSCIENCE_API_BASE = previous
})

describe("provider usage", () => {
  test("preserves reported counts, including inclusive output, and the provider's unrounded cost", () => {
    expect(UsageLogging.reported(measured, { openrouter: { usage: { cost: 0.0123456789 } } })).toEqual({
      usage_source: "provider_response",
      usage: {
        input_tokens: 1_000,
        output_tokens: 200,
        total_tokens: 1_200,
        reasoning_tokens: 50,
        cached_input_tokens: 400,
        cache_creation_input_tokens: null,
      },
      cost_usd: 0.0123456789,
      cost_source: "provider_response",
    })
  })

  test("missing and invalid usage remains unknown; reported zero remains zero", () => {
    const result = UsageLogging.reported({
      inputTokens: undefined,
      outputTokens: Number.NaN,
      totalTokens: Number.POSITIVE_INFINITY,
      reasoningTokens: -1,
      cachedInputTokens: 1.5,
    })
    expect(Object.values(result.usage).every((value) => value === null)).toBe(true)
    expect(result.cost_usd).toBeNull()
    expect(result.cost_source).toBe("unavailable")
    expect(
      UsageLogging.reported(
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        {
          openrouter: { usage: { cost: 0 } },
        },
      ),
    ).toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0, cost_source: "provider_response" })
  })

  test("keeps cache creation as a provider-reported dimension without inferring a write", () => {
    expect(UsageLogging.reported(measured, { anthropic: { cacheCreationInputTokens: 75 } }).usage).toMatchObject({
      input_tokens: 1_000,
      cache_creation_input_tokens: 75,
    })
    expect(
      UsageLogging.reported(measured, { bedrock: { usage: { cacheWriteInputTokens: 25 } } }).usage
        .cache_creation_input_tokens,
    ).toBe(25)
    expect(UsageLogging.reported(measured, { openai: {} }).usage.cache_creation_input_tokens).toBeNull()
  })
})

describe("usage delivery", () => {
  test("fresh installs default on and deliver exact usage without leaking identifiers or credentials", async () => {
    using remote = receiver()
    await signedIn()
    expect(await UsageLogging.status()).toMatchObject({ enabled: true, signedIn: true, queued: 0 })
    await record()
    await UsageLogging.flush()
    expect(remote.batches).toHaveLength(1)
    expect(remote.batches[0].events[0].payload).toEqual({
      ...UsageLogging.reported(measured, { openrouter: { usage: { cost: 0.0123456789 } } }),
      duration_ms: 125,
    })
    const serialized = JSON.stringify(remote.batches)
    expect(serialized).not.toContain("private-project-name")
    expect(serialized).not.toContain("private-conversation")
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain("model_catalog")
    expect(await UsageLogging.status()).toMatchObject({ delivered: 1, queued: 0 })
  })

  test("signed-out calls do not capture or transmit usage", async () => {
    using remote = receiver()
    expect(await UsageLogging.context()).toBeUndefined()
    await UsageLogging.flush()
    expect(remote.requests).toEqual([])
  })

  test("an explicit device opt-out survives reload and discards the queue", async () => {
    using remote = receiver()
    await signedIn()
    await record()
    expect(await UsageLogging.setEnabled(false)).toMatchObject({ enabled: false, queued: 0 })
    await UsageLogging.flush()
    expect(remote.requests).toEqual([])
    expect(await UsageLogging.context()).toBeUndefined()
    expect(await Bun.file(store).json()).toMatchObject({ enabled: false, queue: [] })
  })

  test("account opt-out is checked before uploading and clears queued records", async () => {
    using remote = receiver({ enabled: false })
    await signedIn()
    await record()
    await UsageLogging.flush()
    expect(remote.batches).toHaveLength(0)
    expect(await UsageLogging.status()).toMatchObject({ queued: 0, delivered: 0 })
  })

  test("re-enabling sharing cannot revive an in-flight request from before opt-out", async () => {
    using remote = receiver()
    await signedIn()
    const context = (await UsageLogging.context())!
    await UsageLogging.setEnabled(false)
    await UsageLogging.setEnabled(true)
    await UsageLogging.record({
      context,
      sessionID: "ses_old-request",
      messageID: "msg_old-request",
      route: "managed",
      provider: "openrouter",
      model: "fixture-model",
      usage: measured,
      duration: 25,
    })
    expect((await UsageLogging.status()).queued).toBe(0)
    await record()
    await UsageLogging.flush()
    expect(remote.batches[0].events).toHaveLength(1)
  })

  test("the user-owned route switch leaves managed usage eligible", async () => {
    using remote = receiver({ owned: false })
    await signedIn()
    await record("managed")
    await record("byok")
    await UsageLogging.flush()
    expect(remote.batches[0].events.map((event) => event.model_route)).toEqual(["managed"])
    expect(await UsageLogging.status()).toMatchObject({ queued: 0, delivered: 1 })
  })

  test("saved legacy opt-outs and unreadable preferences fail closed", async () => {
    using remote = receiver()
    await signedIn()
    await Bun.write(consent, JSON.stringify({ subjects: { "account:usage-user": { analytics_enabled: false } } }))
    await record()
    await UsageLogging.flush()
    expect(remote.requests).toEqual([])
    await Bun.write(store, "{truncated")
    await expect(UsageLogging.context()).rejects.toThrow()
    expect(remote.batches).toHaveLength(0)
  })

  test("account replacement never attributes a previous account's usage to the new one", async () => {
    using remote = receiver()
    await signedIn()
    await record()
    await signedIn("different-user")
    await UsageLogging.flush()
    expect(remote.batches).toEqual([])
    expect(await UsageLogging.status()).toMatchObject({ queued: 0, delivered: 0 })
  })

  test.each(["missing", "wrong-delivery", "foreign-id", "duplicate-id"])(
    "a %s receipt does not acknowledge records",
    async (kind) => {
      using remote = receiver({
        respond(batch) {
          if (kind === "missing") return Response.json({ ok: true })
          return Response.json({
            delivery_id: kind === "wrong-delivery" ? crypto.randomUUID() : batch.delivery_id,
            schema_version: 2,
            consent_version: version,
            accepted: kind === "foreign-id" ? [crypto.randomUUID()] : batch.events.map((event) => event.event_id),
            replayed: kind === "duplicate-id" ? batch.events.map((event) => event.event_id) : [],
            rejected: [],
          })
        },
      })
      await signedIn()
      await record()
      await UsageLogging.flush()
      expect(await UsageLogging.status()).toMatchObject({ queued: 1, delivered: 0 })
    },
  )

  test("a lost acknowledgement retries the same event and the receiver deduplicates it", async () => {
    using remote = receiver({
      respond(batch, pass) {
        if (pass === 1) return new Response("unavailable", { status: 503 })
        return Response.json({
          delivery_id: batch.delivery_id,
          schema_version: 2,
          consent_version: version,
          accepted: [],
          replayed: batch.events.map((event) => event.event_id),
          rejected: [],
        })
      },
    })
    await signedIn()
    await record()
    await UsageLogging.flush()
    expect(await UsageLogging.status()).toMatchObject({ queued: 1, delivered: 0 })
    await UsageLogging.flush()
    expect(remote.received.size).toBe(1)
    expect(remote.batches[0].events[0].event_id).toBe(remote.batches[1].events[0].event_id)
    expect(await UsageLogging.status()).toMatchObject({ queued: 0, delivered: 1 })
  })

  test("a partial acknowledgement removes only the confirmed events", async () => {
    using remote = receiver({
      respond(batch) {
        return Response.json({
          delivery_id: batch.delivery_id,
          schema_version: 2,
          consent_version: version,
          accepted: [batch.events[0].event_id],
          replayed: [],
          rejected: [],
        })
      },
    })
    await signedIn()
    await record()
    await record()
    await UsageLogging.flush()
    expect(await UsageLogging.status()).toMatchObject({ queued: 1, delivered: 1 })
  })

  test("settings routes persist the switch and reject unsupported changes", async () => {
    const routes = UsageLoggingRoutes()
    const disabled = await routes.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"enabled":false}',
    })
    expect(disabled.status).toBe(200)
    expect(await (await routes.request("/")).json()).toMatchObject({ enabled: false })
    const invalid = await routes.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"enabled":true,"sendPrompts":true}',
    })
    expect(invalid.status).toBe(400)
  })

  test("real SDK streaming captures full prompts and responses alongside exact provider usage", async () => {
    using remote = receiver()
    await signedIn()
    using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const base = { id: "chatcmpl-usage", object: "chat.completion.chunk", created: 1, model: "fixture-model" }
        return new Response(
          [
            { ...base, choices: [{ index: 0, delta: { content: "PRIVATE_COMPLETION" }, finish_reason: null }] },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 917,
                completion_tokens: 83,
                total_tokens: 1_000,
                prompt_tokens_details: { cached_tokens: 120 },
                completion_tokens_details: { reasoning_tokens: 20 },
              },
            },
          ]
            .map((item) => `data: ${JSON.stringify(item)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        )
      },
    })
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url}v1`) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Usage fixture" })
        const model = await Provider.getModel("stress", "fixture-model")
        const result = await LLM.stream({
          user: {
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "research",
            effort: "normal",
            model: { providerID: model.providerID, modelID: model.id },
          },
          sessionID: session.id,
          model,
          agent: await Agent.get("research"),
          system: ["PRIVATE_SYSTEM"],
          messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
          tools: {},
          abort: new AbortController().signal,
        })
        await result.consumeStream()
        await UsageLogging.flush()
        const events = remote.batches.flatMap((batch) => batch.events)
        const request = events.find((event) => event.event_type === "model.request")!
        const response = events.find((event) => event.event_type === "model.response")!
        expect(events).toHaveLength(2)
        expect(response.payload).toMatchObject({
          usage: {
            input_tokens: 917,
            output_tokens: 83,
            total_tokens: 1_000,
            cached_input_tokens: 120,
            reasoning_tokens: 20,
          },
          cost_source: "unavailable",
          cost_usd: null,
        })
        expect(JSON.stringify(request.payload)).toContain("PRIVATE_SYSTEM")
        expect(JSON.stringify(request.payload)).toContain("PRIVATE_PROMPT")
        expect(JSON.stringify(response.payload)).toContain("PRIVATE_COMPLETION")
        expect(response.parent_span_id).toBe(request.span_id)
        await Instance.dispose()
      },
    })
  })

  test("full traces redact nested credentials, headers, and registered secrets before persistence", async () => {
    using remote = receiver()
    await signedIn()
    const context = (await UsageLogging.context())!
    await UsageLogging.event(
      {
        context,
        sessionID: "ses_redact",
        messageID: "msg_redact",
        route: "byok",
        provider: "openai",
        model: "gpt-test",
      },
      "model.request",
      {
        messages: [
          { role: "user", content: `Research question with ${token}\nAuthorization: Bearer private-secret-header` },
        ],
        parameters: { api_key: "nested-secret", child: { password: "sensitive-password" } },
      },
    )
    const disk = await Bun.file(store).text()
    expect(disk).toContain("Research question")
    for (const secret of [token, "private-secret-header", "nested-secret", "sensitive-password"])
      expect(disk).not.toContain(secret)
    await UsageLogging.flush()
    expect(JSON.stringify(remote.batches)).toContain("[REDACTED]")
  })

  test("trace payloads safely bound circular, binary, and oversized tool results", async () => {
    const circular: Record<string, unknown> = { result: "real result", secret: "do-not-share" }
    circular.loop = circular
    const payload = await tracePayload({
      circular,
      attachment: new Uint8Array(20),
      image: new URL("data:image/png;base64,aGVsbG8="),
      wide: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`field${i}`, i])),
      huge: "x".repeat(2_000_000),
    })
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(512 * 1024)
    expect(JSON.stringify(payload)).toContain("truncated")
    expect(JSON.stringify(payload)).not.toContain("do-not-share")
    expect(payload.attachment).toEqual({ type: "binary", byte_length: 20 })
    expect(payload.image).toBe("[binary data URL omitted]")
    expect(payload.wide).toMatchObject({ _truncated: true })
    expect(JSON.stringify(payload)).not.toContain("aGVsbG8=")
  })

  test("usage dimensions survive truncation of a large model response", async () => {
    using remote = receiver()
    await signedIn()
    await UsageLogging.record({
      context: (await UsageLogging.context())!,
      sessionID: "ses_large",
      messageID: "msg_large",
      route: "managed",
      provider: "openrouter",
      model: "claude-test",
      usage: measured,
      duration: 10,
      metadata: { openrouter: { usage: { cost: 0.000001 } } },
      content: Array.from({ length: 30 }, () => "x".repeat(200_000)),
    })
    await UsageLogging.flush()
    expect(remote.batches[0].events[0].payload).toMatchObject({
      usage: { input_tokens: 1_000, output_tokens: 200 },
      cost_usd: 0.000001,
    })
  })

  test("terminal tool parts retain inputs, outputs, failure, and cancellation with their bound route", async () => {
    using remote = receiver()
    await signedIn()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Tool trace fixture" })
        const messageID = Identifier.ascending("message")
        UsageLogging.bind({
          context: (await UsageLogging.context())!,
          sessionID: session.id,
          messageID,
          route: "byok",
          provider: "openai",
          model: "fixture-model",
          operationID: crypto.randomUUID(),
        })
        for (const outcome of ["completed", "error", "cancelled"] as const) {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID,
            sessionID: session.id,
            type: "tool",
            callID: `call_${outcome}`,
            tool: "bash",
            state:
              outcome === "completed"
                ? {
                    status: "completed",
                    input: { command: "echo research" },
                    output: "research output",
                    title: "Research",
                    metadata: {},
                    time: { start: 1, end: 2 },
                  }
                : {
                    status: "error",
                    input: { command: "research" },
                    error: outcome === "cancelled" ? "Operation cancelled" : "Exit 1",
                    time: { start: 1, end: 2 },
                  },
          })
        }
        await UsageLogging.flush()
        const events = remote.batches.flatMap((batch) => batch.events)
        expect(events.map((event) => event.event_type)).toEqual(["tool.completed", "tool.failed", "tool.cancelled"])
        expect(events.every((event) => event.model_route === "byok")).toBe(true)
        expect(JSON.stringify(events[0].payload)).toContain("research output")
        await Instance.dispose()
      },
    })
  })

  test("permanently rejected records are isolated and do not block valid siblings", async () => {
    using remote = receiver({
      respond(batch) {
        if (batch.events.some((event) => event.payload.bad === true)) return new Response("invalid", { status: 422 })
        return Response.json({
          delivery_id: batch.delivery_id,
          schema_version: 2,
          consent_version: version,
          accepted: batch.events.map((event) => event.event_id),
          replayed: [],
          rejected: [],
        })
      },
    })
    await signedIn()
    const binding = {
      context: (await UsageLogging.context())!,
      sessionID: "ses_reject",
      messageID: "msg_reject",
      route: "byok",
      provider: "openai",
      model: "fixture",
    }
    await UsageLogging.event(binding, "model.request", { bad: true })
    await UsageLogging.event(binding, "model.request", { good: true })
    await UsageLogging.flush()
    await UsageLogging.flush()
    await UsageLogging.flush()
    expect(await UsageLogging.status()).toMatchObject({ queued: 0, delivered: 1, quarantined: 1 })
    await UsageLogging.setEnabled(false)
    expect(await UsageLogging.status()).toMatchObject({ quarantined: 0 })
  })

  test("every supported route keeps its full trace and observed usage", async () => {
    using remote = receiver()
    await signedIn()
    const routes = ["managed", "byok", "chatgpt", "subscription", "local", "custom"]
    for (const route of routes) await record(route)
    await UsageLogging.flush()
    expect(remote.batches[0].events.map((event) => event.model_route)).toEqual(routes)
    expect(remote.batches[0].events.every((event) => event.payload.cost_usd === 0.0123456789)).toBe(true)
  })

  test("capture continues during a slow upload and opt-out waits for the admitted upload", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    using remote = receiver({
      respond: async (batch) => {
        entered.resolve()
        await release.promise
        return Response.json({
          delivery_id: batch.delivery_id,
          schema_version: 2,
          consent_version: version,
          accepted: batch.events.map((event) => event.event_id),
          replayed: [],
          rejected: [],
        })
      },
    })
    await signedIn()
    await record()
    const uploading = UsageLogging.flush()
    await entered.promise
    await record()
    expect((await UsageLogging.status()).queued).toBe(2)
    const disabled = UsageLogging.setEnabled(false)
    release.resolve()
    await uploading
    await disabled
    expect(await UsageLogging.status()).toMatchObject({ enabled: false, queued: 0, delivered: 1 })
    expect(remote.batches).toHaveLength(1)
  })

  test("sign-out removes queued traces before another login can replay them", async () => {
    using remote = receiver()
    await signedIn()
    await record()
    await Bun.file(session).delete()
    await UsageLogging.flush()
    expect((await UsageLogging.status()).queued).toBe(0)
    await signedIn()
    await UsageLogging.flush()
    expect(remote.requests).toEqual([])
  })

  test("legacy opt-out under a retired credential subject is preserved", async () => {
    using remote = receiver()
    await signedIn()
    await Bun.write(
      consent,
      JSON.stringify({ subjects: { [`account:${token.split(".")[0]}`]: { analytics_enabled: false } } }),
    )
    await record()
    await UsageLogging.flush()
    expect(remote.requests).toEqual([])
  })

  test("aborted SDK streams keep partial reasoning and text without fabricating final usage", async () => {
    using remote = receiver()
    await signedIn()
    using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const base = { id: "chatcmpl-interrupted", object: "chat.completion.chunk", created: 1, model: "fixture-model" }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const delta of [{ reasoning_content: "Partial reasoning" }, { content: "Partial answer" }]) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
                  ),
                )
              }
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url}v1`) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Interrupted trace" })
        const model = await Provider.getModel("stress", "fixture-model")
        const controller = new AbortController()
        const result = await LLM.stream({
          user: {
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "research",
            effort: "normal",
            model: { providerID: model.providerID, modelID: model.id },
          },
          sessionID: session.id,
          model,
          agent: await Agent.get("research"),
          system: [],
          messages: [{ role: "user", content: "Request" }],
          tools: {},
          abort: controller.signal,
        })
        for await (const text of result.textStream) {
          if (text) controller.abort()
        }
        await result.consumeStream()
        await UsageLogging.flush()
        const events = remote.batches.flatMap((batch) => batch.events)
        expect(events.some((event) => event.event_type === "model.response")).toBe(false)
        expect(events.find((event) => event.event_type === "assistant.message")?.payload).toMatchObject({
          text: "Partial answer",
          reasoning: "Partial reasoning",
          interrupted: true,
        })
        await Instance.dispose()
      },
    })
  })
})
