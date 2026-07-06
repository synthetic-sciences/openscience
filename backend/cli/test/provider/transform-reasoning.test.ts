import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"

const sessionID = "sess-reasoning-1"
const PROXY_OR = "https://atlas.test/api/llm/proxy/openrouter/v1"
const PROXY_OAI = "https://atlas.test/api/llm/proxy/openai/v1"

const model = (overrides: Partial<any> = {}): any => ({
  id: "test/model",
  providerID: "test",
  api: { id: "model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, output: 64_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
  ...overrides,
})

const orModel = (id: string, apiId: string, extra: Partial<any> = {}) =>
  model({
    id,
    providerID: "openrouter",
    api: { id: apiId, url: "https://openrouter.ai/api/v1", npm: "@openrouter/ai-sdk-provider" },
    ...extra,
  })

describe("ProviderTransform.options — managed OpenRouter reasoning", () => {
  test("reasoning-capable OR model requests unified reasoning + usage, no OpenAI keys", () => {
    const result = ProviderTransform.options({
      model: orModel("openrouter/anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4"),
      sessionID,
      providerOptions: { baseURL: PROXY_OR },
    })
    expect(result.usage).toEqual({ include: true })
    expect(result.reasoning).toEqual({ effort: "medium" })
    expect(result.reasoningEffort).toBeUndefined()
    expect(result.reasoningSummary).toBeUndefined()
    expect(result.include).toBeUndefined()
  })

  test("OR-routed gpt-5 uses reasoning.effort (not the OpenAI keys), even via the managed proxy", () => {
    const result = ProviderTransform.options({
      model: orModel("openrouter/openai/gpt-5", "openai/gpt-5"),
      sessionID,
      providerOptions: { baseURL: PROXY_OR },
    })
    expect(result.usage).toEqual({ include: true })
    expect(result.reasoning).toEqual({ effort: "medium" })
    expect(result.reasoningEffort).toBeUndefined()
    expect(result.reasoningSummary).toBeUndefined()
    expect(result.include).toBeUndefined()
    expect(result.textVerbosity).toBeUndefined()
  })

  test("OR gemini-3 keeps high effort", () => {
    const result = ProviderTransform.options({
      model: orModel("openrouter/google/gemini-3-pro", "google/gemini-3-pro"),
      sessionID,
      providerOptions: {},
    })
    expect(result.reasoning).toEqual({ effort: "high" })
    expect(result.usage).toEqual({ include: true })
  })

  test("OR non-reasoning model gets usage but no reasoning object", () => {
    const result = ProviderTransform.options({
      model: orModel("openrouter/some/chat", "some/chat", {
        capabilities: { ...model().capabilities, reasoning: false },
      }),
      sessionID,
      providerOptions: {},
    })
    expect(result.usage).toEqual({ include: true })
    expect(result.reasoning).toBeUndefined()
  })
})

describe("ProviderTransform.options — BYOK / direct paths stay untouched", () => {
  test("direct OpenAI gpt-5 (BYOK) keeps its OpenAI reasoning keys, no OR keys", () => {
    const result = ProviderTransform.options({
      model: model({
        id: "openai/gpt-5",
        providerID: "openai",
        api: { id: "gpt-5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      }),
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
    expect(result.reasoningEffort).toBe("medium")
    expect(result.promptCacheKey).toBe(sessionID)
    expect(result.reasoning).toBeUndefined()
    expect(result.usage).toBeUndefined()
  })

  test("direct OpenAI-proxy gpt-5 (openai npm) still gets summary + encrypted content", () => {
    const result = ProviderTransform.options({
      model: model({
        id: "openai/gpt-5",
        providerID: "openai",
        api: { id: "gpt-5", url: PROXY_OAI, npm: "@ai-sdk/openai" },
      }),
      sessionID,
      providerOptions: { baseURL: PROXY_OAI },
    })
    expect(result.reasoningSummary).toBe("auto")
    expect(result.include).toEqual(["reasoning.encrypted_content"])
    expect(result.reasoning).toBeUndefined()
  })
})

describe("ProviderTransform.smallOptions — OpenRouter", () => {
  test("small OR calls disable reasoning via the unified shape", () => {
    const result = ProviderTransform.smallOptions(orModel("openrouter/openai/gpt-5-nano", "openai/gpt-5-nano"))
    expect(result).toEqual({ reasoning: { enabled: false } })
  })
})
