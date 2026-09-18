type Rates = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

type ModelPricing = {
  upstream_provider: "anthropic" | "gemini" | "xai" | "meta" | "openrouter"
  hosting_provider?: "azure" | "gemini" | "openrouter"
  /** The only markup on an Ace turn, stated by the account's catalog; the public 5.5% otherwise. */
  funding_fee_bps?: number
  audited_at?: string
  source_url?: string
}

type Cost = { input: number; output: number }

const DEFAULT_FUNDING_FEE_BPS = 550

export function fundingFeePercent(pricing: ModelPricing | undefined): number {
  return (pricing?.funding_fee_bps ?? DEFAULT_FUNDING_FEE_BPS) / 100
}

type RuntimeCost = {
  input: number
  output: number
  cache: { read: number; write: number }
  tiers?: Array<{ input: number; output: number; cache: { read: number; write: number }; threshold: number }>
  experimentalOver200K?: { input: number; output: number; cache: { read: number; write: number } }
}

export type PricingLine = { label: string; value: string }

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 })

function valid(rates: Rates) {
  return [rates.input, rates.output, rates.cache_read, rates.cache_write]
    .filter((value) => value !== undefined)
    .every((value) => Number.isFinite(value) && value! >= 0)
}

function rateLines(rates: Rates, prefix = ""): PricingLine[] {
  return [
    { label: `${prefix}Input`, value: dollars.format(rates.input) },
    { label: `${prefix}Output`, value: dollars.format(rates.output) },
    ...(rates.cache_read ? [{ label: `${prefix}Cached input`, value: dollars.format(rates.cache_read) }] : []),
    ...(rates.cache_write ? [{ label: `${prefix}Cache write`, value: dollars.format(rates.cache_write) }] : []),
  ]
}

/** Ace prices must come from the account's selected upstream, never a generic
 * models.dev OpenRouter entry. Unknown/zero placeholder rates are not "free". */
export function modelPricing(input: {
  access: "managed" | "byok" | "chatgpt"
  pricing?: ModelPricing
  cost: RuntimeCost
  /** The route's Fast mode rates, when it offers one. */
  fast?: RuntimeCost
}): { note: string; lines: PricingLine[] } {
  if (input.access === "chatgpt") return { note: "Included with an eligible ChatGPT subscription.", lines: [] }
  const rates =
    input.access === "managed" && !input.pricing
      ? undefined
      : {
          input: input.cost.input,
          output: input.cost.output,
          cache_read: input.cost.cache.read,
          cache_write: input.cost.cache.write,
        }
  if (!rates || !valid(rates) || (rates.input === 0 && rates.output === 0))
    return {
      note:
        input.access === "managed"
          ? "Usage-based pricing. Rates update from your account."
          : "Check your provider's current pricing.",
      lines: [],
    }
  const tiers = input.cost.tiers?.map((tier) => ({
    ...tier,
    cache_read: tier.cache.read,
    cache_write: tier.cache.write,
  }))
  const stepped = tiers?.filter((tier) => valid(tier) && Number.isFinite(tier.threshold) && tier.threshold > 0) ?? []
  const high = !stepped.length ? input.cost.experimentalOver200K : undefined
  const legacy = high ? { ...high, cache_read: high.cache.read, cache_write: high.cache.write } : undefined
  const fast = input.fast
    ? {
        input: input.fast.input,
        output: input.fast.output,
        cache_read: input.fast.cache.read,
        cache_write: input.fast.cache.write,
      }
    : undefined
  return {
    note:
      input.access === "managed"
        ? `USD per 1M tokens · Wallet rates; provider price plus the ${fundingFeePercent(input.pricing)}% funding fee, no other markup.`
        : "USD per 1M tokens · catalog estimate; billed by your provider.",
    lines: [
      ...rateLines(rates),
      ...stepped.flatMap((tier) => rateLines(tier, `Over ${tier.threshold.toLocaleString()} input · `)),
      ...(legacy && valid(legacy) ? rateLines(legacy, "200,000+ input · ") : []),
      ...(fast && valid(fast) && !(fast.input === 0 && fast.output === 0) ? rateLines(fast, "Fast · ") : []),
    ],
  }
}

/** The Fast toggle's price consequence: the Fast rates, and their multiple of
 * the standard rates when Fast is a uniform premium. */
export function fastRateLabel(fast: Cost | undefined, standard?: Cost): string | undefined {
  if (!fast || !valid(fast) || (fast.input === 0 && fast.output === 0)) return
  const rates = `${dollars.format(fast.input)} in · ${dollars.format(fast.output)} out per 1M tokens`
  if (!standard || !valid(standard) || standard.input <= 0 || standard.output <= 0) return rates
  const multiple = fast.input / standard.input
  if (multiple <= 1 || Math.abs(fast.output / standard.output - multiple) > 0.01) return rates
  return `${Number(multiple.toFixed(2))}× standard · ${rates}`
}

/** What a turn on this route costs per 1M tokens, as the two choices the
 * popover offers change it: Speed picks the Standard or Fast column, and the
 * context cap decides whether the long-context tier can ever apply. */
export type RouteRates = {
  standard: Cost
  fast?: Cost
  /** Fast's multiple of Standard when it is a uniform premium. */
  multiple?: number
  /** Rows for prompts past a threshold, Standard and (when offered) Fast. */
  tiers: Array<{ threshold: number; standard: Cost; fast?: Cost }>
  /** Wallet rates carry the funding fee; a key is billed by the provider. */
  basis: "wallet" | "provider"
  feePercent?: number
}

export function routeRates(input: {
  access: "managed" | "byok" | "chatgpt"
  pricing?: ModelPricing
  cost: RuntimeCost
  fast?: RuntimeCost
}): RouteRates | undefined {
  if (input.access === "chatgpt") return
  if (input.access === "managed" && !input.pricing) return
  const standard = { input: input.cost.input, output: input.cost.output }
  if (!valid(standard) || (standard.input === 0 && standard.output === 0)) return
  const fast = input.fast ? { input: input.fast.input, output: input.fast.output } : undefined
  const fastValid = fast && valid(fast) && !(fast.input === 0 && fast.output === 0) ? fast : undefined
  const ratio = fastValid && standard.input > 0 && standard.output > 0 ? fastValid.input / standard.input : undefined
  const uniform =
    ratio !== undefined && ratio > 1 && fastValid && Math.abs(fastValid.output / standard.output - ratio) <= 0.01
  const fastTiers = new Map((input.fast?.tiers ?? []).map((tier) => [tier.threshold, tier]))
  const tiers = (input.cost.tiers ?? [])
    .filter((tier) => Number.isFinite(tier.threshold) && tier.threshold > 0 && valid(tier))
    .sort((a, b) => a.threshold - b.threshold)
    .map((tier) => {
      const fastTier = fastTiers.get(tier.threshold)
      return {
        threshold: tier.threshold,
        standard: { input: tier.input, output: tier.output },
        ...(fastValid && fastTier && valid(fastTier)
          ? { fast: { input: fastTier.input, output: fastTier.output } }
          : {}),
      }
    })
  return {
    standard,
    ...(fastValid ? { fast: fastValid } : {}),
    ...(uniform && ratio !== undefined ? { multiple: Number(ratio.toFixed(2)) } : {}),
    tiers,
    basis: input.access === "managed" ? "wallet" : "provider",
    ...(input.access === "managed" ? { feePercent: fundingFeePercent(input.pricing) } : {}),
  }
}

/** Currency for a per-1M-token rate: whole cents, a third decimal only for
 * rates under ten cents ($0.075), never a stray half-cent ($15.825). */
export const tokenRate = {
  format(value: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: value < 0.1 ? 3 : 2,
    }).format(value)
  },
}

/** `$2.00 in · $10.00 out`, the shape every rate in the popover takes. */
export function rateLine(cost: { input: number; output: number }) {
  return `${tokenRate.format(cost.input)} in · ${tokenRate.format(cost.output)} out`
}

/** Wallet rates arrive with the funding fee folded in ($2.11 for a $2.00
 * model). The popover shows the provider's price and names the fee once in
 * the tooltip, so the numbers match what the catalog and the provider quote. */
export function providerRate(cost: Cost, rates: RouteRates): Cost {
  if (rates.basis !== "wallet") return cost
  const factor = 1 + (rates.feePercent ?? fundingFeePercent(undefined)) / 100
  return { input: cost.input / factor, output: cost.output / factor }
}

/** Where the numbers come from, in a few words. */
export function rateBasis(rates: RouteRates) {
  return rates.basis === "wallet"
    ? `Provider price · Ace adds the ${rates.feePercent ?? fundingFeePercent(undefined)}% funding fee at billing`
    : "Catalog estimate · billed by your provider"
}

export function pricingUpstream(pricing: ModelPricing | undefined): string | undefined {
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    gemini: "Google Gemini",
    xai: "xAI",
    meta: "Meta",
    openrouter: "OpenRouter",
    azure: "Azure OpenAI",
  }
  const provider = pricing?.hosting_provider ?? pricing?.upstream_provider
  return typeof provider === "string" ? names[provider] : undefined
}
