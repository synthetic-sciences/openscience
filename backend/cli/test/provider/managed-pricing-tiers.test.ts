import { describe, expect, test } from "bun:test"
import { ManagedPricing } from "../../src/provider/managed-pricing"

const model = (tiers: unknown[]) => ({
  id: "anthropic/claude-opus-5.5",
  context_length: 1_000_000,
  upstream_provider: "anthropic",
  hosting_provider: "anthropic",
  pricing: { funding_fee_bps: 0, tiers },
})

const price = (tiers: unknown[]) => ManagedPricing.parse({ models: [model(tiers)] })["anthropic/claude-opus-5.5"]

describe("ManagedPricing tier thresholds", () => {
  test("a tier starts where it declares, even when the previous one ends earlier", () => {
    // The threshold came from the previous tier's max, so a gap in the catalog
    // charged the 201+ rate from 101 tokens up.
    const gap = price([
      { input: 2, output: 12, max_input_tokens: 100 },
      { input: 4, output: 18, min_input_tokens: 201 },
    ])
    expect(gap?.cost.tiers?.[0]?.threshold).toBe(200)
  })

  test("contiguous tiers are unaffected", () => {
    const contiguous = price([
      { input: 2, output: 12, max_input_tokens: 100 },
      { input: 4, output: 18, min_input_tokens: 101 },
    ])
    expect(contiguous?.cost.tiers?.[0]?.threshold).toBe(100)
  })

  test("a selection above the gap but below the tier's min does not pick that tier", () => {
    const gap = price([
      { input: 2, output: 12, max_input_tokens: 100 },
      { input: 4, output: 18, min_input_tokens: 201 },
    ])
    const threshold = gap?.cost.tiers?.[0]?.threshold ?? 0
    // Selection elsewhere is `promptTokens > threshold`, so a 150-token prompt
    // must not satisfy a tier that only starts at 201.
    expect(150 > threshold).toBe(false)
    expect(201 > threshold).toBe(true)
  })

  test("an explicit base min of 1 still prices the model", () => {
    // Token counts start at 1, so `min: 1` is the base tier, identical to an
    // omitted min. The base was looked up with `!tier.min_input_tokens`, which
    // is false for 1, so the model vanished from the catalog entirely.
    const explicit = price([
      { input: 2, output: 12, min_input_tokens: 1 },
      { input: 4, output: 18, min_input_tokens: 200_001 },
    ])
    const omitted = price([
      { input: 2, output: 12 },
      { input: 4, output: 18, min_input_tokens: 200_001 },
    ])
    expect(explicit?.cost.input).toBe(2)
    expect(explicit?.cost).toEqual(omitted?.cost)
  })
})

test("explicit base minima and tier gaps also apply to Fast pricing", () => {
  const row = {
    ...model([{ input: 2, output: 12, min_input_tokens: 1 }]),
    id: "openai/gpt-6-sol",
    upstream_provider: "openrouter",
    hosting_provider: "openai",
    fast_mode: true,
    fast_mode_details: {
      available: true,
      hosting_provider: "openai",
      transport: { service_tier: "priority" },
      pricing: {
        funding_fee_bps: 0,
        verified: true,
        tiers: [
          { input: 4, output: 24, min_input_tokens: 1, max_input_tokens: 100 },
          { input: 8, output: 48, min_input_tokens: 201 },
        ],
      },
    },
  }
  const fast = ManagedPricing.parse({ models: [row] })[row.id]?.modes.fast
  expect(fast?.cost?.input).toBe(4)
  expect(fast?.cost?.tiers?.[0]?.threshold).toBe(200)
})
