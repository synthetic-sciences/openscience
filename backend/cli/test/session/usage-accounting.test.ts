import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session/index"
import { TokenUsage } from "@synsci/util/token-usage"

const model = (): any => ({
  cost: {
    input: 3,
    output: 15,
    cache: { read: 0.3, write: 3.75 },
    experimentalOver200K: { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  },
  modes: {
    fast: {
      cost: {
        input: 6,
        output: 30,
        cache: { read: 0.6, write: 7.5 },
      },
    },
  },
})

describe("Session.getUsage cost/token accounting", () => {
  for (const route of [
    { name: "OpenAI Responses", input: 1_000, metadata: { openai: {} } },
    { name: "OpenRouter", input: 1_000, metadata: { openrouter: {} } },
    { name: "Google", input: 1_000, metadata: { google: {} } },
    { name: "Anthropic", input: 800, metadata: { anthropic: {} } },
    { name: "Amazon Bedrock", input: 800, metadata: { bedrock: { usage: {} } } },
  ]) {
    test(`${route.name} keeps reasoning as an output subset`, () => {
      const result = Session.getUsage({
        model: model(),
        usage: {
          inputTokens: route.input,
          outputTokens: 500,
          reasoningTokens: 100,
          cachedInputTokens: 200,
        } as any,
        metadata: route.metadata as any,
      })

      expect(result.tokens).toEqual({
        input: 800,
        output: 500,
        reasoning: 100,
        cache: { read: 200, write: 0 },
      })
      expect(TokenUsage.uncached(result.tokens)).toBe(1_300)
      expect(TokenUsage.total(result.tokens)).toBe(1_500)
      expect(result.cost).toBeCloseTo((800 * 3 + 500 * 15 + 200 * 0.3) / 1_000_000, 8)
    })
  }

  test("over-200k tier trips on a mostly-cache-write prompt (cache.write counts toward the threshold)", () => {
    // 15k fresh input + 190k cache-creation = 205k > 200k → over-200k pricing.
    const r = Session.getUsage({
      model: model(),
      usage: { inputTokens: 15_000, outputTokens: 100, cachedInputTokens: 0 } as any,
      metadata: { anthropic: { cacheCreationInputTokens: 190_000 } } as any,
    })
    // input billed at the over-200k rate (6/M), not the base 3/M.
    expect(r.cost).toBeCloseTo((15_000 * 6 + 100 * 22.5 + 190_000 * 7.5) / 1_000_000, 6)
  })

  test("stays on the base tier below 200k", () => {
    const r = Session.getUsage({
      model: model(),
      usage: { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0 } as any,
    })
    expect(r.cost).toBeCloseTo((1_000 * 3 + 100 * 15) / 1_000_000, 6)
  })

  test("uses the catalog's exact context threshold instead of the legacy 200k guess", () => {
    const priced = model()
    priced.cost.tiers = [{ input: 10, output: 45, cache: { read: 1, write: 0 }, threshold: 272_000 }]
    const below = Session.getUsage({
      model: priced,
      usage: { inputTokens: 271_999, outputTokens: 100, cachedInputTokens: 0 } as any,
      metadata: { anthropic: {} } as any,
    })
    const exact = Session.getUsage({
      model: priced,
      usage: { inputTokens: 272_000, outputTokens: 100, cachedInputTokens: 0 } as any,
      metadata: { anthropic: {} } as any,
    })
    expect(below.cost).toBeCloseTo((271_999 * 3 + 100 * 15) / 1_000_000, 6)
    expect(exact.cost).toBeCloseTo((272_000 * 3 + 100 * 15) / 1_000_000, 6)
    const above = Session.getUsage({
      model: priced,
      usage: { inputTokens: 272_001, outputTokens: 100, cachedInputTokens: 0 } as any,
      metadata: { anthropic: {} } as any,
    })
    expect(above.cost).toBeCloseTo((272_001 * 10 + 100 * 45) / 1_000_000, 6)
  })

  test("clamps a would-be-negative input token count to zero (non-excludes provider)", () => {
    // inputTokens already excludes cached, but provider isn't in the excludes set:
    // 100 - 500 cacheRead = -400 → must clamp to 0, never negative tokens/cost.
    const r = Session.getUsage({
      model: model(),
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 500 } as any,
    })
    expect(r.tokens.input).toBe(0)
    expect(r.cost).toBeGreaterThanOrEqual(0)
  })

  test("uses the selected service mode's pricing", () => {
    const r = Session.getUsage({
      model: model(),
      tier: "fast",
      usage: { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0 } as any,
    })
    expect(r.cost).toBeCloseTo((1_000 * 6 + 100 * 30) / 1_000_000, 6)
  })

  test("Fast mode uses its own long-context rates only above the published boundary", () => {
    const priced = model()
    priced.modes!.fast!.cost!.tiers = [{ input: 12, output: 45, cache: { read: 1.2, write: 15 }, threshold: 272_000 }]
    for (const input of [272_000, 272_001]) {
      const result = Session.getUsage({
        model: priced,
        tier: "fast",
        usage: { inputTokens: input, outputTokens: 100, cachedInputTokens: 0 } as any,
      })
      expect(result.cost).toBeCloseTo(
        (input * (input > 272_000 ? 12 : 6) + 100 * (input > 272_000 ? 45 : 30)) / 1_000_000,
        6,
      )
    }
    const cached = Session.getUsage({
      model: priced,
      tier: "fast",
      usage: { inputTokens: 10_000, outputTokens: 100, cachedInputTokens: 0 } as any,
      metadata: { anthropic: { cacheCreationInputTokens: 270_000 } } as any,
    })
    expect(cached.cost).toBeCloseTo((10_000 * 12 + 100 * 45 + 270_000 * 15) / 1_000_000, 6)
  })
})
