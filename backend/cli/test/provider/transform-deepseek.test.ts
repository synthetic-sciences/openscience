import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"

const sessionID = "sess-deepseek-1"

const model = (overrides: Partial<any> = {}): any => ({
  id: "deepseek/deepseek-v4-flash",
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
  cost: { input: 0.14, output: 0.28, cache: { read: 0.0028, write: 0 } },
  limit: { context: 1_000_000, output: 384_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-07-31",
  reasoningOptions: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
  ...overrides,
})

describe("ProviderTransform.variants — deepseek native adapter", () => {
  test("deepseek-v4 uses the catalog effort ladder via reasoningEffort", () => {
    const v = ProviderTransform.variants(model())
    expect(v).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
  })

  test("deepseek-v4 without catalog efforts falls back to low/medium/high/max", () => {
    const v = ProviderTransform.variants(model({ reasoningOptions: undefined }))
    expect(Object.keys(v)).toEqual(["low", "medium", "high", "max"])
    expect(v.max).toEqual({ reasoningEffort: "max" })
  })

  test("deepseek-v4 through openai-compatible maps the same ladder", () => {
    const v = ProviderTransform.variants(
      model({
        reasoningOptions: undefined,
        api: { id: "deepseek-v4-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
      }),
    )
    expect(Object.keys(v)).toEqual(["low", "medium", "high", "max"])
  })

  test("non-v4 deepseek models expose no effort variants", () => {
    expect(
      ProviderTransform.variants(
        model({
          id: "deepseek/deepseek-chat",
          api: { id: "deepseek-chat", url: "https://api.deepseek.com", npm: "@ai-sdk/deepseek" },
          reasoningOptions: undefined,
        }),
      ),
    ).toEqual({})
  })

  test("a model configured as non-reasoning offers no variants", () => {
    expect(ProviderTransform.variants(model({ capabilities: { ...model().capabilities, reasoning: false } }))).toEqual(
      {},
    )
  })
})

describe("ProviderTransform.options — deepseek thinking control", () => {
  test("deepseek-v4 configured as non-reasoning disables thinking", () => {
    const result = ProviderTransform.options({
      model: model({ capabilities: { ...model().capabilities, reasoning: false } }),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinking).toEqual({ type: "disabled" })
  })

  test("deepseek-v4 reasoning-capable keeps thinking enabled (no disable flag)", () => {
    const result = ProviderTransform.options({
      model: model(),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinking).toBeUndefined()
  })

  test("non-v4 deepseek models get no thinking option", () => {
    const result = ProviderTransform.options({
      model: model({ api: { id: "deepseek-chat", url: "https://api.deepseek.com", npm: "@ai-sdk/deepseek" } }),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinking).toBeUndefined()
  })

  test("deepseek-v4 on openai-compatible gets no thinking option", () => {
    const result = ProviderTransform.options({
      model: model({
        api: { id: "deepseek-v4-flash", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
      }),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinking).toBeUndefined()
  })
})

describe("ProviderTransform.smallOptions — deepseek", () => {
  test("small deepseek-v4 calls disable thinking", () => {
    expect(ProviderTransform.smallOptions(model())).toEqual({ thinking: { type: "disabled" } })
  })

  test("small non-v4 deepseek calls emit nothing", () => {
    expect(
      ProviderTransform.smallOptions(
        model({ api: { id: "deepseek-chat", url: "https://api.deepseek.com", npm: "@ai-sdk/deepseek" } }),
      ),
    ).toEqual({})
  })
})
