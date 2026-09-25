type Rates = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

type ModelPricing = {
  upstream_provider: "anthropic" | "gemini" | "xai" | "meta" | "openrouter"
  hosting_provider?: "azure" | "openai" | "anthropic" | "gemini" | "xai" | "bedrock" | "openrouter"
  billing_basis?: string
  /** Route-specific metadata; catalog costs are already Wallet-inclusive. */
  funding_fee_bps?: number
  audited_at?: string
  source_url?: string
}

type Cost = { input: number; output: number }

function known(pricing: ModelPricing | undefined) {
  const fee = pricing?.funding_fee_bps
  const host = pricing?.hosting_provider
  return (
    host !== undefined && Number.isInteger(fee) && fee! >= 0 && fee! <= 9_999 && (host === "openrouter" || fee === 0)
  )
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

function rateLines(rates: Rates, prefix = "", maximum = false): PricingLine[] {
  const qualifier = maximum ? "Up to " : ""
  return [
    { label: `${prefix}Input`, value: qualifier + dollars.format(rates.input) },
    { label: `${prefix}Output`, value: qualifier + dollars.format(rates.output) },
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
  fastPricing?: ModelPricing
}): { note: string; lines: PricingLine[] } {
  if (input.access === "chatgpt") return { note: "Included with an eligible ChatGPT subscription.", lines: [] }
  const rates =
    input.access === "managed" && !known(input.pricing)
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
  const fast =
    input.fast && (input.access !== "managed" || known(input.fastPricing))
      ? {
          input: input.fast.input,
          output: input.fast.output,
          cache_read: input.fast.cache.read,
          cache_write: input.fast.cache.write,
        }
      : undefined
  const fastTiers = (input.fast?.tiers ?? [])
    .map((tier) => ({ ...tier, cache_read: tier.cache.read, cache_write: tier.cache.write }))
    .filter((tier) => valid(tier) && Number.isFinite(tier.threshold) && tier.threshold > 0)
  const maximum = input.access === "managed" && input.pricing?.billing_basis === "provider_reported_cost"
  const fastMaximum = input.access === "managed" && input.fastPricing?.billing_basis === "provider_reported_cost"
  return {
    note:
      input.access === "managed"
        ? maximum
          ? fast && !fastMaximum
            ? "USD per 1M tokens · Standard input and output are maximum estimates; Standard cache prices are estimates. Fast uses exact Wallet rates."
            : "USD per 1M tokens · Wallet input and output are maximum estimates; cache prices are estimates."
          : fast && fastMaximum
            ? "USD per 1M tokens · Standard uses exact Wallet rates. Fast input and output are maximum estimates; Fast cache prices are estimates."
            : "USD per 1M tokens · Wallet rates."
        : "USD per 1M tokens · catalog estimate; billed by your provider.",
    lines: [
      ...rateLines(rates, "", maximum),
      ...stepped.flatMap((tier) => rateLines(tier, `Over ${tier.threshold.toLocaleString()} input · `, maximum)),
      ...(legacy && valid(legacy) ? rateLines(legacy, "200,000+ input · ", maximum) : []),
      ...(fast && valid(fast) && !(fast.input === 0 && fast.output === 0)
        ? [
            ...rateLines(fast, "Fast · ", fastMaximum),
            ...fastTiers.flatMap((tier) =>
              rateLines(tier, `Fast · Over ${tier.threshold.toLocaleString()} input · `, fastMaximum),
            ),
          ]
        : []),
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
  /** Wallet rates include any applicable route fee; a key is billed by the provider. */
  basis: "wallet" | "provider"
  maximum?: boolean
  fastMaximum?: boolean
}

export function routeRates(input: {
  access: "managed" | "byok" | "chatgpt"
  pricing?: ModelPricing
  cost: RuntimeCost
  fast?: RuntimeCost
  fastPricing?: ModelPricing
}): RouteRates | undefined {
  if (input.access === "chatgpt") return
  if (input.access === "managed" && !known(input.pricing)) return
  const standard = { input: input.cost.input, output: input.cost.output }
  if (!valid(standard) || (standard.input === 0 && standard.output === 0)) return
  const fast =
    input.fast && (input.access !== "managed" || known(input.fastPricing))
      ? { input: input.fast.input, output: input.fast.output }
      : undefined
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
    ...(input.access === "managed" && input.pricing?.billing_basis === "provider_reported_cost"
      ? { maximum: true }
      : {}),
    ...(input.access === "managed" && input.fastPricing?.billing_basis === "provider_reported_cost"
      ? { fastMaximum: true }
      : {}),
  }
}

/** Keep fractional-cent Wallet rates consistent with Rates and limits. */
export const tokenRate = dollars

/** `$2.00 in · $10.00 out`, the shape every rate in the popover takes. */
export function rateLine(cost: { input: number; output: number }, maximum = false) {
  const qualifier = maximum ? "Up to " : ""
  return `${qualifier}${tokenRate.format(cost.input)} in · ${qualifier}${tokenRate.format(cost.output)} out`
}

/** Where the numbers come from, in a few words. */
export function rateBasis(rates: RouteRates, fast = false) {
  if (fast ? rates.fastMaximum : rates.maximum) return "Wallet maximum input and output rates"
  return rates.basis === "wallet" ? "Wallet rates" : "Catalog estimate · billed by your provider"
}

export function pricingUpstream(pricing: ModelPricing | undefined): string | undefined {
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    gemini: "Google Gemini",
    xai: "xAI",
    meta: "Meta",
    openrouter: "OpenRouter",
    azure: "Azure OpenAI",
    openai: "OpenAI",
    bedrock: "Amazon Bedrock",
  }
  const provider = pricing?.hosting_provider ?? pricing?.upstream_provider
  return typeof provider === "string" ? names[provider] : undefined
}
