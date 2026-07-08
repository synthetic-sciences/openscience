import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session/index"

const model = (): any => ({
  cost: {
    input: 3,
    output: 15,
    cache: { read: 0.3, write: 3.75 },
    experimentalOver200K: { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  },
})

describe("Session.getUsage cost/token accounting", () => {
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
})
