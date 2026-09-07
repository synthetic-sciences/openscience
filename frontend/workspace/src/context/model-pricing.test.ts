import { describe, expect, test } from "bun:test"
import { fastRateLabel, fundingFeePercent, modelPricing, pricingUpstream } from "./model-pricing"

const cost = { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }

describe("route-aware model pricing", () => {
  test("Ace never presents an OpenRouter catalog rate as a direct provider rate", () => {
    expect(modelPricing({ access: "managed", cost }).lines).toEqual([])
    const result = modelPricing({
      access: "managed",
      cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      pricing: { upstream_provider: "anthropic" },
    })
    expect(result.lines[0]).toEqual({ label: "Input", value: "$5.00" })
    expect(result.lines[3]).toEqual({ label: "Cache write", value: "$6.25" })
  })

  test("preserves exact long-context boundaries and discounted server prices", () => {
    const result = modelPricing({
      access: "managed",
      pricing: { upstream_provider: "openrouter" },
      cost: {
        input: 2,
        output: 10,
        cache: { read: 0, write: 0 },
        tiers: [{ threshold: 272_000, input: 4, output: 15, cache: { read: 0, write: 0 } }],
      },
    })
    expect(result.lines[0]?.value).toBe("$2.00")
    expect(result.lines[2]).toEqual({ label: "Over 272,000 input · Input", value: "$4.00" })
  })

  test("states the funding fee as the only markup, from the account's catalog when it has one", () => {
    const managed = modelPricing({ access: "managed", cost, pricing: { upstream_provider: "openrouter" } })
    expect(managed.note).toBe(
      "USD per 1M tokens · Wallet rates; provider price plus the 5.5% funding fee, no other markup.",
    )
    expect(managed.note).not.toContain("credit")
    const stated = modelPricing({
      access: "managed",
      cost,
      pricing: { upstream_provider: "openrouter", funding_fee_bps: 700 },
    })
    expect(stated.note).toContain("plus the 7% funding fee")
    expect(fundingFeePercent(undefined)).toBe(5.5)
    expect(fundingFeePercent({ upstream_provider: "openrouter", funding_fee_bps: 0 })).toBe(0)
    expect(modelPricing({ access: "byok", cost }).note).not.toContain("funding fee")
  })

  test("shows the Fast rates beside the standard ones when the route offers a Fast mode", () => {
    const fast = { input: 4, output: 20, cache: { read: 0.4, write: 5 } }
    const result = modelPricing({ access: "managed", cost, pricing: { upstream_provider: "openrouter" }, fast })
    expect(result.lines.slice(0, 4).map((line) => line.label)).toEqual([
      "Input",
      "Output",
      "Cached input",
      "Cache write",
    ])
    expect(result.lines.slice(4)).toEqual([
      { label: "Fast · Input", value: "$4.00" },
      { label: "Fast · Output", value: "$20.00" },
      { label: "Fast · Cached input", value: "$0.40" },
      { label: "Fast · Cache write", value: "$5.00" },
    ])
    expect(modelPricing({ access: "managed", cost, pricing: { upstream_provider: "openrouter" } }).lines).toHaveLength(
      4,
    )
    // A zero placeholder is not a free Fast lane.
    expect(
      modelPricing({
        access: "managed",
        cost,
        pricing: { upstream_provider: "openrouter" },
        fast: { ...fast, input: 0, output: 0 },
      }).lines,
    ).toHaveLength(4)
    expect(fastRateLabel({ input: 4, output: 20 }, { input: 2, output: 10 })).toBe(
      "2× standard · $4.00 in · $20.00 out per 1M tokens",
    )
    expect(fastRateLabel({ input: 4, output: 20 }, { input: 2, output: 4 })).toBe("$4.00 in · $20.00 out per 1M tokens")
    expect(fastRateLabel({ input: 4, output: 20 })).toBe("$4.00 in · $20.00 out per 1M tokens")
    expect(fastRateLabel({ input: 2, output: 10 }, { input: 2, output: 10 })).toBe(
      "$2.00 in · $10.00 out per 1M tokens",
    )
    expect(fastRateLabel({ input: 0, output: 0 }, cost)).toBeUndefined()
    expect(fastRateLabel(undefined, cost)).toBeUndefined()
  })

  test("subscription and unknown prices are never displayed as free token rates", () => {
    expect(modelPricing({ access: "chatgpt", cost }).lines).toEqual([])
    expect(modelPricing({ access: "byok", cost: { ...cost, input: 0, output: 0 } }).lines).toEqual([])
    expect(
      modelPricing({ access: "managed", cost: { ...cost, input: NaN }, pricing: { upstream_provider: "anthropic" } })
        .lines,
    ).toEqual([])
    expect(pricingUpstream({ upstream_provider: "openrouter" })).toBe("OpenRouter")
    expect(pricingUpstream(undefined)).toBeUndefined()
  })
})
