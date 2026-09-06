import { expect, test } from "bun:test"
import { generateText, streamText, tool } from "ai"
import z from "zod"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelsDev } from "../../src/provider/models"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

function catalog(id: "openai" | "anthropic") {
  return ModelsDev.Provider.parse({
    id,
    name: id,
    api: `https://${id}.example.test/v1`,
    npm: id === "openai" ? "@ai-sdk/openai" : "@ai-sdk/anthropic",
    env: [],
    models: {},
  })
}

test("new native model contracts survive an absent or stale model catalog", () => {
  for (const [providerID, id, context, output] of [
    ["openai", "gpt-6-astra", 1_050_000, 128_000],
    ["anthropic", "claude-fable-5-1", 1_000_000, 128_000],
  ] as const) {
    const source = catalog(providerID)
    const fresh = Provider.fromModelsDevProvider(source).models[id]
    expect(fresh.limit.context).toBe(context)
    expect(fresh.limit.output).toBe(output)
    expect(fresh.capabilities.temperature).toBe(false)
    expect(Object.keys(fresh.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(fresh.reasoningOptions?.find((option) => option.type === "effort")?.default).toBe(
      providerID === "anthropic" ? "high" : undefined,
    )
    expect(fresh.modes).toBeUndefined()
    source.models[id] = {
      id,
      name: "Old metadata",
      release_date: "2020-01-01",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: false,
      options: {},
      provider: { npm: "@ai-sdk/openai-compatible" },
      reasoning_options: [{ type: "effort", values: ["none"] }],
      limit: { context: 32_000, output: 4_096 },
      experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } },
    }
    const refreshed = Provider.fromModelsDevProvider(source).models[id]
    expect(refreshed).toEqual(fresh)
  }
})

test("Astra API and Codex options preserve their distinct defaults and valid efforts", () => {
  const api = Provider.fromModelsDevProvider(catalog("openai")).models["gpt-6-astra"]
  const codex = { ...api, providerID: "openai-codex" }
  const options = (model: Provider.Model) => ProviderTransform.options({ model, sessionID: "fixture" })
  expect(Provider.isCodexOAuthModel(api.id)).toBe(true)
  expect(options(api)).toMatchObject({
    store: false,
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
  })
  expect(options(api).reasoningEffort).toBeUndefined()
  expect(options(codex).reasoningEffort).toBe("medium")
  expect(Object.keys(ProviderTransform.variants(codex))).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(ProviderTransform.smallOptions(api)).toEqual({ reasoningEffort: "low" })
  expect(ProviderTransform.smallOptions(codex)).toEqual({ reasoningEffort: "low" })
  for (const id of ["openai/gpt-6-astra", "anthropic/claude-fable-5.1"]) {
    const routed = { ...api, id, api: { ...api.api, id, npm: "@openrouter/ai-sdk-provider" } }
    expect(ProviderTransform.smallOptions(routed)).toEqual({ reasoning: { effort: "low" } })
  }
})

test("native Astra actually uses Responses with tools, selected max, replay and no rejected sampling fields", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() })
      return Response.json({ error: { message: "offline wire capture" } }, { status: 400 })
    },
  })
  await using tmp = await tmpdir({
    config: { provider: { openai: { options: { apiKey: "fixture", baseURL: `${server.url}v1` } } } },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        const model = await Provider.getModel("openai", "gpt-6-astra")
        const options = {
          ...ProviderTransform.options({ model, sessionID: "fixture" }),
          ...ProviderTransform.variants(model).max,
          logprobs: true,
        }
        await generateText({
          model: await Provider.getLanguage(model),
          prompt: "Use probe",
          tools: { probe: tool({ inputSchema: z.object({ value: z.string() }) }) },
          providerOptions: ProviderTransform.providerOptions(model, options),
          temperature: 0.9,
          topP: 0.8,
          maxOutputTokens: 128,
          maxRetries: 0,
        }).catch(() => undefined)
        expect(requests).toHaveLength(1)
        expect(requests[0].path).toBe("/v1/responses")
        expect(requests[0].body).toMatchObject({
          model: "gpt-6-astra",
          max_output_tokens: 128,
          reasoning: { effort: "max", summary: "auto" },
          tools: [{ type: "function", name: "probe" }],
        })
        expect(requests[0].body.include).toContain("reasoning.encrypted_content")
        expect(requests[0].body.include).not.toContain("message.output_text.logprobs")
        for (const field of ["temperature", "top_p", "logprobs", "top_logprobs"])
          expect(requests[0].body[field]).toBeUndefined()
      },
    })
  } finally {
    Provider.invalidate()
    server.stop(true)
  }
})

test("native Fable sends adaptive thinking, high/default and max, and documented binding controls without touching earlier models", async () => {
  const requests: { path: string; headers: Headers; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.json() })
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "offline wire capture" } },
        { status: 400 },
      )
    },
  })
  await using tmp = await tmpdir({
    config: { provider: { anthropic: { options: { apiKey: "fixture", baseURL: `${server.url}v1` } } } },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        const model = await Provider.getModel("anthropic", "claude-fable-5-1")
        const language = await Provider.getLanguage(model)
        for (const effort of [undefined, "max"] as const) {
          const options = {
            ...ProviderTransform.options({ model, sessionID: "fixture" }),
            ...(effort ? ProviderTransform.variants(model)[effort] : {}),
          }
          await generateText({
            model: language,
            prompt: "Use probe",
            tools: { probe: tool({ inputSchema: z.object({ value: z.string() }) }) },
            providerOptions: ProviderTransform.providerOptions(model, options),
            maxOutputTokens: 128,
            maxRetries: 0,
          }).catch(() => undefined)
        }
        expect(requests).toHaveLength(2)
        for (const [index, request] of requests.entries()) {
          expect(request.path).toBe("/v1/messages")
          expect(request.body).toMatchObject({
            model: "claude-fable-5-1",
            thinking: {
              type: "adaptive",
              display: "summarized",
              block_binding: { prefix_mismatch_behavior: "drop_block" },
            },
            output_config: { effort: index === 0 ? "high" : "max" },
            tool_choice: { type: "auto" },
          })
          expect(request.headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01")
          expect(request.body.speed).toBeUndefined()
        }
        await expect(
          generateText({
            model: language,
            prompt: "Probe",
            tools: { probe: tool({ inputSchema: z.object({}) }) },
            toolChoice: "required",
            maxRetries: 0,
          }),
        ).rejects.toThrow("does not support forced tool selection")
        expect(requests).toHaveLength(2)
      },
    })
  } finally {
    Provider.invalidate()
    server.stop(true)
  }
  for (const model of ["claude-opus-5", "claude-fable-5"]) {
    const older = { model, thinking: { type: "adaptive" }, tool_choice: { type: "any" } }
    expect(Provider.normalizeFableRequestBody(older)).toBe(older)
  }
})

test("unverified OpenRouter Fable is not automatically advertised, while explicit BYOK config remains user-owned", async () => {
  const id = "anthropic/claude-fable-5.1"
  const native = catalog("anthropic")
  const source = ModelsDev.Provider.parse({
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    env: [],
    models: {},
  })
  expect(Provider.fromModelsDevProvider(source).models[id]).toBeUndefined()
  source.models[id] = {
    id,
    name: "Catalog Fable 5.1",
    release_date: "2026-09-01",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    limit: { context: 1_000_000, output: 128_000 },
    options: {},
  }
  expect(Provider.fromModelsDevProvider(source).models[id]).toBeUndefined()
  expect(source.models[id]).toBeDefined()
  expect(Provider.fromModelsDevProvider(native).models["claude-fable-5-1"]).toBeDefined()

  await using tmp = await tmpdir({
    config: {
      billing: { llm: "byok" },
      provider: {
        openrouter: {
          options: { apiKey: "fixture-byok" },
          models: { [id]: { name: "My explicit Fable route", limit: { context: 1_000_000, output: 128_000 } } },
        },
      },
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        const configured = await Provider.getModel("openrouter", id)
        expect(configured.name).toBe("My explicit Fable route")
        expect(configured.api.id).toBe(id)
        expect(configured.api.npm).toBe("@openrouter/ai-sdk-provider")
        expect((await Provider.getProvider("openrouter"))?.source).not.toBe("managed")
      },
    })
  } finally {
    Provider.invalidate()
  }
})

test("native Fable streams supplied reasoning and progress verbatim, retaining signatures before a tool call", async () => {
  const reasoning = ["**Checking the input**\n\n", "Keep  every byte, including α.\n"]
  const progress = "Next I’ll run the fixture probe."
  const events = [
    { type: "message_start", message: { id: "msg_fixture", model: "claude-fable-5-1", usage: { input_tokens: 12 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    ...reasoning.map((thinking) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    })),
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "fixture-reasoning-signature" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: progress } },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "fixture-progress-signature" },
    },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_fixture", name: "probe" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"value":"fixture"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 24 } },
    { type: "message_stop" },
  ]
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ body: await request.json(), headers: request.headers })
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await using tmp = await tmpdir({
    config: { provider: { anthropic: { options: { apiKey: "fixture", baseURL: `${server.url}v1` } } } },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        const model = await Provider.getModel("anthropic", "claude-fable-5-1")
        const response = streamText({
          model: await Provider.getLanguage(model),
          prompt: "Run the local fixture.",
          tools: { probe: tool({ inputSchema: z.object({ value: z.string() }) }) },
          providerOptions: ProviderTransform.providerOptions(model, ProviderTransform.variants(model).low),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(2_000),
        })
        const text: string[] = []
        const calls: unknown[] = []
        const errors: unknown[] = []
        for await (const part of response.fullStream) {
          if (part.type === "reasoning-delta") text.push(part.text)
          if (part.type === "tool-call") calls.push({ name: part.toolName, input: part.input })
          if (part.type === "error") errors.push(part.error)
        }
        expect(errors).toEqual([])
        expect(text.join("")).toBe(reasoning.join("") + progress)
        expect(calls).toEqual([{ name: "probe", input: { value: "fixture" } }])
        expect(await response.reasoning).toMatchObject([
          { text: reasoning.join(""), providerMetadata: { anthropic: { signature: "fixture-reasoning-signature" } } },
          { text: progress, providerMetadata: { anthropic: { signature: "fixture-progress-signature" } } },
        ])
        expect(requests).toHaveLength(1)
        expect(requests[0].body).toMatchObject({
          thinking: {
            type: "adaptive",
            display: "summarized",
            block_binding: { prefix_mismatch_behavior: "drop_block" },
          },
          output_config: { effort: "low" },
          stream: true,
        })
        expect(requests[0].headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01")
      },
    })
  } finally {
    Provider.invalidate()
    server.stop(true)
  }
})
