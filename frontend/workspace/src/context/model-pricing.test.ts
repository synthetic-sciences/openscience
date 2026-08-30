import { describe, expect, test } from "bun:test"
import { modelPricing, pricingUpstream } from "./model-pricing"

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
