import { describe, expect, test } from "bun:test"
import { fastRateLabel, modelPricing, pricingUpstream, rateBasis, rateLine, routeRates } from "./model-pricing"

const cost = { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }

describe("route-aware model pricing", () => {
  test("marks variable Wallet input and output as maxima across standard, Fast and context tiers", () => {
    const input = {
      access: "managed" as const,
      pricing: {
        upstream_provider: "openrouter" as const,
        hosting_provider: "openrouter" as const,
        funding_fee_bps: 550,
        billing_basis: "provider_reported_cost",
      },
      cost: { ...cost, tiers: [{ ...cost, threshold: 200_000 }] },
      fastPricing: {
        upstream_provider: "openrouter" as const,
        hosting_provider: "openrouter" as const,
        funding_fee_bps: 550,
        billing_basis: "provider_reported_cost",
      },
      fast: { ...cost, input: 4, output: 20, tiers: [{ ...cost, input: 8, output: 40, threshold: 200_000 }] },
    }
    const result = modelPricing(input)
    expect(result.lines.filter((line) => /(?:Input|Output)$/.test(line.label)).map((line) => line.value)).toEqual([
      "Up to $2.00",
      "Up to $10.00",
      "Up to $2.00",
      "Up to $10.00",
      "Up to $4.00",
      "Up to $20.00",
      "Up to $8.00",
      "Up to $40.00",
    ])
    expect(result.lines[2]?.value).toBe("$0.20")
    expect(result.note).toContain("cache prices are estimates")
    expect(result.note).not.toMatch(/provider|fee|%/i)
    const rates = routeRates(input)!
    expect(rates.maximum).toBe(true)
    expect(rateBasis(rates)).toBe("Wallet maximum input and output rates")
    expect(rateLine(rates.standard, rates.maximum)).toBe("Up to $2.00 in · Up to $10.00 out")
    for (const billing_basis of ["anthropic_token_usage", "azure_token_usage", "gemini_token_usage"]) {
      const exact = { ...input, pricing: { ...input.pricing, billing_basis } }
      expect(modelPricing(exact).lines[0]?.value).toBe("$2.00")
      expect(routeRates(exact)?.maximum).toBeUndefined()
    }
    const byok = { ...input, access: "byok" as const }
    expect(modelPricing(byok).lines[0]?.value).toBe("$2.00")
    expect(routeRates(byok)?.maximum).toBeUndefined()
  })
  test("identifies Azure hosting behind the compatible managed transport", () => {
    expect(pricingUpstream({ upstream_provider: "openrouter", hosting_provider: "azure" })).toBe("Azure OpenAI")
    expect(pricingUpstream({ upstream_provider: "openrouter", hosting_provider: "anthropic" })).toBe("Anthropic")
    expect(pricingUpstream({ upstream_provider: "openrouter", hosting_provider: "gemini" })).toBe("Google Gemini")
    expect(pricingUpstream({ upstream_provider: "openrouter" })).toBe("OpenRouter")
  })
  test("Ace never presents an OpenRouter catalog rate as a direct provider rate", () => {
    expect(modelPricing({ access: "managed", cost }).lines).toEqual([])
    const result = modelPricing({
      access: "managed",
      cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      pricing: { upstream_provider: "anthropic", hosting_provider: "anthropic", funding_fee_bps: 0 },
    })
    expect(result.lines[0]).toEqual({ label: "Input", value: "$5.00" })
    expect(result.lines[3]).toEqual({ label: "Cache write", value: "$6.25" })
  })

  test("preserves exact long-context boundaries and discounted server prices", () => {
    const result = modelPricing({
      access: "managed",
      pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
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

  test("shows Wallet rates without exposing routing or fee percentages", () => {
    const managed = modelPricing({
      access: "managed",
      cost,
      pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
    })
    expect(managed.note).toBe("USD per 1M tokens · Wallet rates.")
    expect(managed.note).not.toContain("credit")
    const stated = modelPricing({
      access: "managed",
      cost,
      pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 700 },
    })
    expect(stated.note).toBe(managed.note)
    expect(stated.note).not.toMatch(/provider|fee|%/i)
    expect(rateLine({ input: 5.275, output: 31.65 })).toBe("$5.275 in · $31.65 out")
    expect(modelPricing({ access: "byok", cost }).note).not.toContain("funding fee")
  })

  test("shows the Fast rates beside the standard ones when the route offers a Fast mode", () => {
    const fast = { input: 4, output: 20, cache: { read: 0.4, write: 5 } }
    const result = modelPricing({
      access: "managed",
      cost,
      pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
      fast,
      fastPricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
    })
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
    expect(
      modelPricing({
        access: "managed",
        cost,
        pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
      }).lines,
    ).toHaveLength(4)
    // A zero placeholder is not a free Fast lane.
    expect(
      modelPricing({
        access: "managed",
        cost,
        pricing: { upstream_provider: "openrouter", hosting_provider: "openrouter", funding_fee_bps: 550 },
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
      modelPricing({
        access: "managed",
        cost: { ...cost, input: NaN },
        pricing: { upstream_provider: "anthropic", hosting_provider: "anthropic", funding_fee_bps: 0 },
      }).lines,
    ).toEqual([])
    expect(pricingUpstream({ upstream_provider: "openrouter" })).toBe("OpenRouter")
    expect(pricingUpstream(undefined)).toBeUndefined()
  })
})

test("a direct Fast route has exact prices beside maximum OpenRouter Standard quotes", () => {
  const input = {
    access: "managed" as const,
    cost,
    fast: { ...cost, input: 4, output: 20 },
    pricing: {
      upstream_provider: "openrouter" as const,
      hosting_provider: "openrouter" as const,
      funding_fee_bps: 550,
      billing_basis: "provider_reported_cost",
    },
    fastPricing: {
      upstream_provider: "openrouter" as const,
      hosting_provider: "openai" as const,
      funding_fee_bps: 0,
      billing_basis: "openai_token_usage",
    },
  }
  const rates = routeRates(input)!
  expect(rateLine(rates.standard, rates.maximum)).toBe("Up to $2.00 in · Up to $10.00 out")
  expect(rateLine(rates.fast!, rates.fastMaximum)).toBe("$4.00 in · $20.00 out")
  expect(rateBasis(rates, true)).toBe("Wallet rates")
  expect(modelPricing(input).lines.find((line) => line.label === "Fast · Input")?.value).toBe("$4.00")
  expect(modelPricing(input).note).toContain("Standard input and output are maximum estimates")
  expect(modelPricing(input).note).toContain("Fast uses exact Wallet rates")
  expect(routeRates({ ...input, fastPricing: undefined })?.fast).toBeUndefined()
  expect(routeRates({ ...input, pricing: { ...input.pricing, hosting_provider: "azure" } })).toBeUndefined()
  expect(routeRates({ ...input, pricing: { upstream_provider: "openrouter" } })).toBeUndefined()
  expect(modelPricing({ ...input, pricing: undefined }).lines).toEqual([])
})
