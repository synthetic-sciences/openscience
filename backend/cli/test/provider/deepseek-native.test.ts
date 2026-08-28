import { describe, expect, test } from "bun:test"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { generateText, tool } from "ai"
import z from "zod"
import { ModelsDev } from "../../src/provider/models"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { Instance } from "../../src/project/instance"
import { Env } from "../../src/env"
import { tmpdir } from "../fixture/fixture"

const target = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "deepseek-v4-flash",
    providerID: "deepseek",
    api: { id: "deepseek-v4-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/deepseek" },
    name: "DeepSeek V4 Flash",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: { field: "reasoning_content" },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 32_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-07-31",
    ...overrides,
  }) as any

describe("native DeepSeek provider", () => {
  test("normalizes the official catalog route without changing OpenRouter", () => {
    const direct = Provider.fromModelsDevProvider(
      ModelsDev.Provider.parse({
        id: "deepseek",
        name: "DeepSeek",
        api: "https://api.deepseek.com",
        npm: "@ai-sdk/openai-compatible",
        env: ["DEEPSEEK_API_KEY"],
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            release_date: "2026-07-31",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            provider: { npm: "@ai-sdk/openai-compatible" },
            limit: { context: 128_000, output: 32_000 },
            options: {},
          },
        },
      }),
    )
    expect(direct.models["deepseek-v4-flash"].api.npm).toBe("@ai-sdk/deepseek")

    const relay = Provider.fromModelsDevProvider(
      ModelsDev.Provider.parse({
        id: "openrouter",
        name: "OpenRouter",
        api: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
        env: ["OPENROUTER_API_KEY"],
        models: {
          "deepseek/deepseek-v4-flash": {
            id: "deepseek/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            release_date: "2026-07-31",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 128_000, output: 32_000 },
            options: {},
          },
        },
      }),
    )
    expect(relay.models["deepseek/deepseek-v4-flash"].api.npm).toBe("@openrouter/ai-sdk-provider")
  })

  test("honors the official BYOK base URL while an explicit OpenRouter selection stays exact", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "openrouter/deepseek/deepseek-r1",
        provider: { deepseek: { whitelist: ["deepseek-v4-flash"] } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("DEEPSEEK_API_KEY", "direct-test")
        Env.set("DEEPSEEK_BASE_URL", "https://deepseek.example.test")
        Env.set("OPENROUTER_API_KEY", "relay-test")
        Provider.invalidate()
      },
      fn: async () => {
        try {
          const providers = await Provider.list()
          expect(providers.deepseek.options.baseURL).toBe("https://deepseek.example.test")
          const directModels = Object.values(providers.deepseek.models)
          expect(directModels.length).toBeGreaterThan(0)
          expect(directModels.every((model) => model.api.npm === "@ai-sdk/deepseek")).toBe(true)
          expect(await Provider.defaultModel()).toEqual({
            providerID: "openrouter",
            modelID: "deepseek/deepseek-r1",
          })
        } finally {
          Env.remove("DEEPSEEK_API_KEY")
          Env.remove("DEEPSEEK_BASE_URL")
          Env.remove("OPENROUTER_API_KEY")
          Provider.invalidate()
        }
      },
    })
  })

  test("keeps config-defined DeepSeek models on the native adapter", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          deepseek: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "direct-test" },
            models: {
              "deepseek-v4-custom": {
                name: "DeepSeek V4 Custom",
                reasoning: true,
                tool_call: true,
                limit: { context: 128_000, output: 32_000 },
              },
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Provider.getModel("deepseek", "deepseek-v4-custom")).api.npm).toBe("@ai-sdk/deepseek")
      },
    })
  })

  test("exposes only DeepSeek V4 canonical effort tiers and disables thinking for small calls", () => {
    expect(ProviderTransform.variants(target())).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
    expect(ProviderTransform.smallOptions(target())).toEqual({ thinking: { type: "disabled" } })
  })

  test("keeps reasoning parts for the native adapter to replay through a tool loop", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "prior reasoning" },
          { type: "tool-call", toolCallId: "call_1", toolName: "probe", input: {} },
        ],
      },
    ] as any
    expect(ProviderTransform.message(messages, target(), {})).toEqual(messages)
  })

  test("serializes V4 thinking and tools without forcing tool_choice", async () => {
    const bodies: Record<string, unknown>[] = []
    const sdk = createDeepSeek({
      apiKey: "test",
      baseURL: "https://deepseek.test",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")))
        return Response.json({ error: { message: "captured" } }, { status: 400 })
      }) as typeof globalThis.fetch,
    })
    await generateText({
      model: sdk.chat("deepseek-v4-flash"),
      prompt: "probe",
      providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "max" } },
      tools: { probe: tool({ description: "Probe", inputSchema: z.object({ value: z.string() }) }) },
    }).catch(() => undefined)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    })
    expect(bodies[0].tools).toBeArray()
    expect(bodies[0].tool_choice).toBe("auto")
    expect((Provider.normalizeDeepSeekRequestBody(bodies[0]) as Record<string, unknown>).tool_choice).toBeUndefined()
    expect(
      (
        Provider.normalizeDeepSeekRequestBody({
          ...bodies[0],
          thinking: { type: "disabled" },
        }) as Record<string, unknown>
      ).tool_choice,
    ).toBe("auto")
  })
})
