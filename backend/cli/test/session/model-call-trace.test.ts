import { expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { CallLink } from "../../src/provider/call-link"
import { ModelCallTrace } from "../../src/session/model-call-trace"
import { SessionTraceStore } from "../../src/session/trace-store"
import { Storage } from "../../src/storage/storage"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { tmpdir, trustProject } from "../fixture/fixture"
import { stressProviderConfig } from "../fixture/stress-provider"

function tracker() {
  const sessionID = `ses_attempt_${crypto.randomUUID()}`
  return {
    sessionID,
    trace: ModelCallTrace.create({
      context: { sessionID, messageID: "msg_attempt", attempt: 1 },
      route: "byok",
      provider: "openai",
      model: "fixture",
    }),
  }
}
function request(trace: ReturnType<typeof ModelCallTrace.create>, url: string, signal?: AbortSignal) {
  return Provider.withRequestContext(trace.context, () =>
    Provider.fetchWithIdleWatchdog(
      fetch,
      url,
      { method: "POST", body: JSON.stringify({ model: "fixture" }), signal },
      { providerID: "openai", modelID: "fixture", connectTimeout: 1000, idleTimeout: false },
    ),
  )
}

test("the durable attempt exists before dispatch and receives exact provider fields after completion", async () => {
  const item = tracker()
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      const state = await SessionTraceStore.read(item.sessionID)
      expect(state.modelCalls).toHaveLength(1)
      expect(state.modelCalls[0]).toMatchObject({ outcome: "pending", attempt: 1 })
      expect(state.modelCalls[0]!.reported).toBeUndefined()
      return new Response("ok")
    },
  })
  const response = await request(item.trace, server.url.toString())
  await response.text()
  const call = CallLink.fromResponse(Object.fromEntries(response.headers), "provider_receipt")
  await item.trace.complete(call, { inputTokens: 0, outputTokens: 3, totalTokens: 3 })
  expect((await SessionTraceStore.read(item.sessionID)).modelCalls).toMatchObject([
    {
      id: call!.id,
      outcome: "completed",
      httpStatus: 200,
      providerRequest: "provider_receipt",
      reported: {
        input_tokens: 0,
        output_tokens: 3,
        total_tokens: 3,
        reasoning_tokens: null,
        cached_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      reportedCostUSD: null,
    },
  ])
  await SessionTraceStore.remove(item.sessionID)
})

test("a refused connection leaves a failed call without inventing usage or charges", async () => {
  const item = tracker()
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
  const url = probe.url.toString()
  await probe.stop(true)
  await expect(request(item.trace, url)).rejects.toBeInstanceOf(Provider.TransportError)
  const calls = (await SessionTraceStore.read(item.sessionID)).modelCalls
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ outcome: "failed", provider: "openai", model: "fixture" })
  expect(calls[0]!.reported).toBeUndefined()
  expect(calls[0]!.reportedCostUSD).toBeUndefined()
  await SessionTraceStore.remove(item.sessionID)
})

test("body cancellation retains the original call identity and explicit cancelled outcome", async () => {
  const item = tracker()
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"))
          },
        }),
      ),
  })
  const response = await request(item.trace, server.url.toString())
  const id = response.headers.get(CallLink.CALL_HEADER)
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  await reader.cancel("fixture cancellation")
  expect((await SessionTraceStore.read(item.sessionID)).modelCalls).toMatchObject([
    { id, outcome: "cancelled", httpStatus: 200 },
  ])
  await SessionTraceStore.remove(item.sessionID)
})

test("HTTP failures and retries retain separate attempt identities", async () => {
  const item = tracker()
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unavailable", { status: 503 }),
  })
  for (let index = 0; index < 2; index++) await (await request(item.trace, server.url.toString())).text()
  const calls = (await SessionTraceStore.read(item.sessionID)).modelCalls
  expect(calls).toHaveLength(2)
  expect(calls[0]!.id).not.toBe(calls[1]!.id)
  expect(calls.every((call) => call.outcome === "failed" && call.httpStatus === 503)).toBe(true)
  await SessionTraceStore.remove(item.sessionID)
})

test.each([true, false])("structured configuration calls use the same trace path, valid output %s", async (valid) => {
  const before = await (
    await Storage.research()
  ).query((db) =>
    db
      .query<{ session_id: string }, []>(
        "SELECT DISTINCT session_id FROM model_call WHERE session_id LIKE 'agent-config:%'",
      )
      .all(),
  )
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        id: "chatcmpl_configuration",
        object: "chat.completion",
        created: 1,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: valid
                ? JSON.stringify({
                    identifier: "configuration_fixture",
                    whenToUse: "fixture only",
                    systemPrompt: "Read and explain.",
                  })
                : "not valid JSON",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
      }),
  })
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${server.url}v1`) })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const operation = Agent.generate({
        description: "Local configuration trace fixture",
        model: { providerID: "stress", modelID: "fixture-model" },
      })
      if (valid) expect(await operation).toMatchObject({ identifier: "configuration_fixture" })
      else await expect(operation).rejects.toThrow()
    },
  })
  const known = new Set(before.map((item) => item.session_id))
  const ids = await (
    await Storage.research()
  ).query((db) =>
    db
      .query<{ session_id: string }, []>(
        "SELECT DISTINCT session_id FROM model_call WHERE session_id LIKE 'agent-config:%'",
      )
      .all(),
  )
  const id = ids.find((item) => !known.has(item.session_id))!.session_id
  const calls = (await SessionTraceStore.read(id)).modelCalls
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    outcome: valid ? "completed" : "failed",
    providerRequest: "chatcmpl_configuration",
    reported: { input_tokens: 20, output_tokens: 7, total_tokens: 27, reasoning_tokens: null },
    reportedCostUSD: null,
  })
  await SessionTraceStore.remove(id)
})
