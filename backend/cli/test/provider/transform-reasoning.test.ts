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
      model: orModel("openrouter/deepseek/deepseek-r1", "deepseek/deepseek-r1"),
      sessionID,
      providerOptions: { baseURL: PROXY_OR },
    })
    expect(result.usage).toEqual({ include: true })
    expect(result.reasoning).toEqual({ effort: "medium" })
    expect(result.reasoningEffort).toBeUndefined()
    expect(result.reasoningSummary).toBeUndefined()
    expect(result.include).toBeUndefined()
  })

  test("Claude via OpenRouter requests unified reasoning for managed inference", () => {
    const result = ProviderTransform.options({
      model: orModel("openrouter/anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4"),
      sessionID,
      providerOptions: { baseURL: PROXY_OR },
    })
    expect(result.usage).toEqual({ include: true })
    expect(result.reasoning).toEqual({ effort: "medium" })
  })

  test("Claude via OpenRouter supports reasoning when only api.id carries a mixed-case token", () => {
    const upper = ProviderTransform.options({
      model: orModel("openrouter/some-alias", "Anthropic/Claude-Sonnet-4"),
      sessionID,
      providerOptions: { baseURL: PROXY_OR },
    })
    expect(upper.reasoning).toEqual({ effort: "medium" })

    const aliased = ProviderTransform.options({
      model: orModel("openrouter/anthropic/claude-x", "vendor/opaque-slug"),
      sessionID,
      providerOptions: { baseURL: PROXY_OR },
    })
    expect(aliased.reasoning).toEqual({ effort: "medium" })
  })

  test("Claude via OpenRouter offers the unified reasoning-effort variants", () => {
    expect(
      Object.keys(
        ProviderTransform.variants(orModel("openrouter/anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4")),
      ),
    ).toEqual(["low", "medium", "high"])
    expect(
      Object.keys(ProviderTransform.variants(orModel("openrouter/some-alias", "Anthropic/Claude-Sonnet-4"))),
    ).toEqual(["low", "medium", "high"])
  })

  test("a non-Claude OR model whose id merely contains a vendor token is unaffected", () => {
    // deepseek model, id has no claude/anthropic → keeps reasoning + effort variants.
    const opts = ProviderTransform.options({
      model: orModel("openrouter/deepseek/deepseek-r1", "deepseek/deepseek-r1"),
      sessionID,
      providerOptions: { baseURL: PROXY_OR },
    })
    expect(opts.reasoning).toEqual({ effort: "medium" })
    expect(
      Object.keys(ProviderTransform.variants(orModel("openrouter/deepseek/deepseek-r1", "deepseek/deepseek-r1"))),
    ).toContain("medium")
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

describe("new model reasoning effort contracts", () => {
  test("GPT-5.6 family exposes none through max on direct OpenAI and managed OpenRouter", () => {
    const expected = ["none", "low", "medium", "high", "xhigh", "max"]
    const direct = model({
      id: "gpt-5.6-sol",
      providerID: "openai",
      release_date: "2026-07-09",
      api: { id: "gpt-5.6-sol", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    })
    const managed = orModel("openai/gpt-5.6-sol", "openai/gpt-5.6-sol", { release_date: "2026-07-09" })
    expect(Object.keys(ProviderTransform.variants(direct))).toEqual(expected)
    expect(Object.keys(ProviderTransform.variants(managed))).toEqual(expected)
    expect(ProviderTransform.variants(direct).max).toEqual({
      reasoningEffort: "max",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    })
    expect(ProviderTransform.variants(managed).max).toEqual({ reasoning: { effort: "max" } })
  })

  test("GPT-5.6 OpenRouter Pro routes keep the full effort ladder", () => {
    const pro = orModel("openai/gpt-5.6-sol-pro", "openai/gpt-5.6-sol-pro", {
      release_date: "2026-07-09",
    })
    expect(Object.keys(ProviderTransform.variants(pro))).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  })

  test("Codex OAuth exposes each model's exact live effort ladder", () => {
    const codex = (id: string) =>
      model({
        id,
        providerID: "openai-codex",
        release_date: "2026-07-09",
        api: { id, url: "https://chatgpt.com/backend-api/codex", npm: "@ai-sdk/openai" },
      })
    expect(Object.keys(ProviderTransform.variants(codex("gpt-5.6-sol")))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ])
    expect(Object.keys(ProviderTransform.variants(codex("gpt-5.6-terra")))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ])
    expect(Object.keys(ProviderTransform.variants(codex("gpt-5.6-luna")))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(Object.keys(ProviderTransform.variants(codex("gpt-5.5")))).toEqual(["low", "medium", "high", "xhigh"])
    expect(ProviderTransform.variants(codex("gpt-5.6-sol")).none).toBeUndefined()
    expect(ProviderTransform.variants(codex("gpt-5.6-sol")).ultra).toEqual({
      reasoningEffort: "ultra",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    })

    expect(ProviderTransform.options({ model: codex("gpt-5.6-sol"), sessionID, providerOptions: {} })).toMatchObject({
      reasoningEffort: "low",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    })
    expect(
      ProviderTransform.options({ model: codex("gpt-5.6-terra"), sessionID, providerOptions: {} }).reasoningEffort,
    ).toBe("medium")
    expect(ProviderTransform.options({ model: codex("gpt-5.4"), sessionID, providerOptions: {} }).reasoningEffort).toBe(
      "medium",
    )
  })

  test("public OpenAI defaults GPT-5.4 to none but GPT-5.5 and GPT-5.6 to medium", () => {
    const openai = (id: string) =>
      model({
        id,
        providerID: "openai",
        api: { id, url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
      })
    for (const id of ["gpt-5.4", "gpt-5-4", "gpt-5.4-mini", "gpt-5-4-mini"]) {
      expect(ProviderTransform.options({ model: openai(id), sessionID, providerOptions: {} }).reasoningEffort).toBe(
        "none",
      )
    }
    for (const id of ["gpt-5.5", "gpt-5.6", "gpt-5.6-sol"]) {
      expect(ProviderTransform.options({ model: openai(id), sessionID, providerOptions: {} }).reasoningEffort).toBe(
        "medium",
      )
    }
  })

  test("dash-normalized versioned GPT-5 Codex ids use a supported small-call effort", () => {
    for (const id of ["gpt-5-6-sol", "gpt-5-6-terra", "gpt-5-6-luna", "gpt-5-5", "gpt-5-4", "gpt-5-4-mini"]) {
      const codex = model({
        id,
        providerID: "openai-codex",
        api: { id, url: "https://chatgpt.com/backend-api/codex", npm: "@ai-sdk/openai" },
      })
      expect(ProviderTransform.smallOptions(codex)).toEqual({ reasoningEffort: "low" })
    }
  })

  test("Grok 4.5 exposes low/medium/high with provider-specific wire shapes", () => {
    const direct = model({
      id: "grok-4.5",
      providerID: "xai",
      api: { id: "grok-4.5", url: "https://api.x.ai/v1", npm: "@ai-sdk/xai" },
    })
    const managed = orModel("x-ai/grok-4.5", "x-ai/grok-4.5")
    expect(ProviderTransform.variants(direct)).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    })
    // Direct xAI's documented default is high. Omit the option so the provider
    // owns that default; a selected variant still serializes an explicit effort.
    expect(ProviderTransform.options({ model: direct, sessionID, providerOptions: {} }).reasoningEffort).toBeUndefined()
    expect(ProviderTransform.variants(managed)).toEqual({
      low: { reasoning: { effort: "low" } },
      medium: { reasoning: { effort: "medium" } },
      high: { reasoning: { effort: "high" } },
    })
    expect(
      ProviderTransform.options({ model: managed, sessionID, providerOptions: { baseURL: PROXY_OR } }).reasoning,
    ).toEqual({ effort: "high" })
    expect(ProviderTransform.smallOptions(direct)).toEqual({ reasoningEffort: "low" })
    expect(ProviderTransform.smallOptions(managed)).toEqual({ reasoning: { effort: "low" } })
  })

  test("Muse Spark 1.1 exposes its exact effort ladder on BYOK and legacy Meta proxy", () => {
    const muse = model({
      id: "muse-spark-1.1",
      providerID: "meta",
      api: { id: "muse-spark-1.1", url: "https://api.meta.ai/v1", npm: "@ai-sdk/openai" },
    })
    expect(ProviderTransform.variants(muse)).toEqual({
      minimal: { reasoningEffort: "minimal" },
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    })
    expect(
      ProviderTransform.options({
        model: muse,
        sessionID,
        providerOptions: { baseURL: "https://atlas.test/api/llm/proxy/meta/v1" },
      }),
    ).toEqual({ store: false, include: ["reasoning.encrypted_content"] })
    expect(ProviderTransform.options({ model: muse, sessionID, providerOptions: {} }).reasoningEffort).toBeUndefined()
    expect(ProviderTransform.smallOptions(muse)).toEqual({ reasoningEffort: "minimal" })
    // @ai-sdk/openai's Responses implementation parses the literal `openai`
    // options namespace even when createOpenAI({ name: "meta" }) reports its
    // provider as `meta.responses`. Keep this pinned-SDK seam explicit so a
    // semantic-looking remap to `meta` cannot silently drop the effort.
    expect(ProviderTransform.providerOptions(muse, { reasoningEffort: "high" })).toEqual({
      openai: { reasoningEffort: "high" },
    })
  })
})

describe("ProviderTransform.variants — Anthropic max thinking budget", () => {
  const claude = (cap: number) =>
    model({
      id: "anthropic/claude-opus-4-1",
      providerID: "anthropic",
      api: { id: "claude-opus-4-1", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
      limit: { context: 200_000, output: cap },
    })

  test("max thinking budget leaves real text headroom on a 32k-output model", () => {
    const v = ProviderTransform.variants(claude(32_000))
    const budget = (v.max as any).thinking.budgetTokens
    expect(budget).toBeLessThan(32_000)
    const textTokens = ProviderTransform.maxOutputTokens(
      "@ai-sdk/anthropic",
      { thinking: { type: "enabled", budgetTokens: budget } },
      32_000,
      32_000,
    )
    // Was 1 before the fix — now a usable amount of text.
    expect(textTokens).toBeGreaterThanOrEqual(4_096)
  })

  test("large-cap models still clamp the budget at 31,999", () => {
    const v = ProviderTransform.variants(claude(64_000))
    expect((v.max as any).thinking.budgetTokens).toBe(31_999)
  })
})

describe("ProviderTransform.variants — Gemini-3 nests under thinkingConfig", () => {
  test("effort variants are wrapped so @ai-sdk/google actually reads them", () => {
    const gem = model({
      id: "google/gemini-3-pro",
      providerID: "google",
      api: { id: "gemini-3-pro", url: "https://generativelanguage.googleapis.com", npm: "@ai-sdk/google" },
    })
    const v = ProviderTransform.variants(gem)
    expect(v.low).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } })
    expect(v.high).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } })
    expect((v.low as any).thinkingLevel).toBeUndefined()
  })
})

describe("ProviderTransform.smallOptions — OpenRouter", () => {
  test("small OR calls disable reasoning via the unified shape", () => {
    const result = ProviderTransform.smallOptions(orModel("openrouter/openai/gpt-5-nano", "openai/gpt-5-nano"))
    expect(result).toEqual({ reasoning: { enabled: false } })
  })
})
