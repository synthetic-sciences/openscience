import { expect, test } from "bun:test"
import { generateText, tool } from "ai"
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
            thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
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
  const older = { model: "claude-opus-5", thinking: { type: "adaptive" }, tool_choice: { type: "any" } }
  expect(Provider.normalizeFableRequestBody(older)).toBe(older)
})
