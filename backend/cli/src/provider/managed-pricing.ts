import { createHash } from "node:crypto"
import z from "zod"
import type { Provider } from "./provider"
import { GlobalBus } from "@/bus/global"
import { managedApiBase } from "@/endpoints"
import { OpenScience, type FundingSnapshot } from "@/openscience"
import { MANAGED_OPENROUTER_MODEL_SET } from "./managed-catalog"

const Rate = z.number().finite().nonnegative().max(100_000)
const Tokens = z.number().int().positive().max(20_000_000)
const Tier = z.object({
  input: Rate,
  output: Rate,
  cache_read: Rate.optional(),
  cache_write: Rate.optional(),
  min_input_tokens: Tokens.optional(),
  max_input_tokens: Tokens.optional(),
})
const Host = z.enum(["azure", "openai", "anthropic", "gemini", "xai", "bedrock", "openrouter"])
const Fee = z.number().int().min(0).max(9_999)
const Price = z.object({
  hosting_provider: Host.optional(),
  funding_fee_bps: Fee.optional(),
  service_fee_bps: Fee.optional(),
  billing_basis: z.string().max(64).optional(),
  audited_at: z.string().max(32).optional(),
  source_url: z.url().max(2048).optional(),
  verified: z.boolean().optional(),
  tiers: z.array(Tier).min(1).max(8),
})
const Entry = z.object({
  id: z.string(),
  available: z.boolean().optional(),
  upstream_provider: z.enum(["anthropic", "gemini", "xai", "meta", "openrouter"]),
  hosting_provider: Host.optional(),
  context_length: Tokens,
  max_output_tokens: Tokens.optional(),
  context_options: z.array(Tokens).max(8).optional(),
  capabilities: z
    .object({
      reasoning_efforts: z
        .array(z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]))
        .max(8)
        .optional(),
      reasoning_default: z.string().max(32).optional(),
      thinking_budgets: z.array(z.number().int().min(0).max(20_000_000)).max(8).optional(),
    })
    .optional(),
  fast_mode: z.boolean().optional(),
  fast_mode_details: z
    .object({
      available: z.boolean(),
      hosting_provider: Host.optional(),
      transport: z
        .union([z.object({ service_tier: z.literal("priority") }), z.object({ speed: z.literal("fast") })])
        .optional(),
      pricing: Price.optional(),
    })
    .optional(),
  pricing: Price,
})

export namespace ManagedPricing {
  export type Catalog = { prices: Record<string, Model>; availability: Record<string, boolean> }

  export type Model = {
    cost: {
      input: number
      output: number
      cache: { read: number; write: number }
      tiers?: Array<{ input: number; output: number; cache: { read: number; write: number }; threshold: number }>
    }
    pricing: {
      upstream_provider: z.infer<typeof Entry>["upstream_provider"]
      hosting_provider: z.infer<typeof Host>
      billing_basis?: string
      funding_fee_bps: number
      audited_at?: string
      source_url?: string
    }
    limit: { context: number; output?: number }
    contextOptions: number[]
    reasoningOptions: Array<Record<string, unknown>>
    modes: Record<
      string,
      {
        cost?: Model["cost"]
        pricing: Model["pricing"]
        provider: { body: Record<string, string>; headers?: Record<string, string> }
      }
    >
  }

  /** Whitelist non-executable metadata. Never accept remote API URLs, npm
   * packages, headers, keys, or authorization decisions. Transport flags below
   * are reconstructed locally from a closed, route-specific allowlist. */
  export function parse(value: unknown): Record<string, Model> {
    const body = z.object({ models: z.array(z.unknown()).max(100) }).safeParse(value)
    if (!body.success) return {}
    const result: Record<string, Model> = {}
    for (const row of body.data.models) {
      const parsed = Entry.safeParse(row)
      if (!parsed.success) continue
      const model = parsed.data
      if (!MANAGED_OPENROUTER_MODEL_SET.has(model.id) || model.available === false) continue
      const pricing = metadata(model.pricing, model.hosting_provider, model.upstream_provider)
      if (!pricing) continue
      const first = model.pricing.tiers.find((tier) => !tier.min_input_tokens)
      if (!first || (first.input === 0 && first.output === 0)) continue
      const cost = (tier: z.infer<typeof Tier>) => ({
        input: tier.input,
        output: tier.output,
        cache: { read: tier.cache_read ?? 0, write: tier.cache_write ?? 0 },
      })
      const tiers = (prices: z.infer<typeof Tier>[]) =>
        prices
          .map((tier, index) => ({
            ...tier,
            threshold: prices[index - 1]?.max_input_tokens ?? (tier.min_input_tokens ?? 1) - 1,
          }))
          .filter((tier) => tier.min_input_tokens !== undefined && tier.threshold > 0)
          .map((tier) => ({ ...cost(tier), threshold: tier.threshold }))
          .sort((a, b) => a.threshold - b.threshold)
      const fast = model.fast_mode_details
      const transport = fast?.transport
      const premium = fast?.pricing?.tiers.find((tier) => !tier.min_input_tokens)
      // Priority is served by OpenRouter's reviewed endpoints, OpenAI's own API
      // beside an Azure-hosted standard tier, or xAI's priority processing.
      // Gemini and Bedrock hosts have no such tier, so their models never
      // gain the body flag whatever the catalog says.
      const fastPricing = fast?.pricing && metadata(fast.pricing, fast.hosting_provider, model.upstream_provider)
      const fastHost = fastPricing?.hosting_provider
      const body: Record<string, string> | undefined =
        model.upstream_provider === "openrouter" &&
        fastHost &&
        ["openrouter", "openai", "xai"].includes(fastHost) &&
        /^(?:openai\/gpt-6-(?:astra|sol|luna)|x-ai\/grok-4\.7)$/.test(model.id) &&
        transport &&
        "service_tier" in transport
          ? { service_tier: "priority" }
          : undefined
      const efforts = model.capabilities?.reasoning_efforts
      const fallback = model.capabilities?.reasoning_default
      result[model.id] = {
        contextOptions: [...new Set([...(model.context_options ?? []), model.context_length])]
          .filter((value) => value <= model.context_length)
          .sort((a, b) => a - b),
        reasoningOptions: [
          ...(efforts?.length
            ? [
                {
                  type: "effort",
                  values: efforts,
                  ...(fallback && efforts.includes(fallback as (typeof efforts)[number]) ? { default: fallback } : {}),
                },
              ]
            : []),
          ...(model.capabilities?.thinking_budgets?.length
            ? [{ type: "budget_tokens", values: model.capabilities.thinking_budgets }]
            : []),
        ],
        modes:
          model.fast_mode && fast?.available && fast.pricing?.verified === true && fastPricing && premium && body
            ? {
                fast: {
                  cost: { ...cost(premium), tiers: tiers(fast.pricing.tiers) },
                  pricing: fastPricing,
                  provider: { body },
                },
              }
            : {},
        cost: {
          ...cost(first),
          tiers: tiers(model.pricing.tiers),
        },
        pricing,
        limit: {
          context: model.context_length,
          ...(model.max_output_tokens ? { output: model.max_output_tokens } : {}),
        },
      }
    }
    return result
  }

  /** Availability is independent of price validity: an explicit denial must not
   * disappear into the offline pricing fallback. Unknown models remain ignored. */
  export function availability(value: unknown): Record<string, boolean> {
    const body = z.object({ models: z.array(z.unknown()).max(100) }).safeParse(value)
    if (!body.success) return {}
    const result: Record<string, boolean> = {}
    for (const row of body.data.models) {
      const parsed = z.object({ id: z.string(), available: z.boolean() }).safeParse(row)
      if (!parsed.success || !MANAGED_OPENROUTER_MODEL_SET.has(parsed.data.id)) continue
      // Conflicting duplicates fail closed regardless of their ordering.
      result[parsed.data.id] = result[parsed.data.id] !== false && parsed.data.available
    }
    return result
  }

  const fingerprint = (snapshot: FundingSnapshot) =>
    createHash("sha256")
      .update(`${snapshot.api_key}\0${snapshot.user_id}\0${snapshot.organization_id ?? "personal"}`)
      .digest("hex")
  let cached: { key: string; at: number; value: Catalog } | undefined
  let pending: { key: string; promise: Promise<void> } | undefined
  const TTL = 60_000
  const TIMEOUT = 3_000

  async function refresh(snapshot: FundingSnapshot, key: string) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT)
    try {
      // A legacy unscoped session resolves its workspace through the account
      // service first; that read shares the one deadline with the catalog
      // fetch so a stalled status call cannot hold the refresh open.
      const expired = new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new Error("Model pricing request timed out")), {
          once: true,
        }),
      )
      const selected = await Promise.race([OpenScience.managedRequestSnapshot(snapshot.api_key, snapshot), expired])
      if (fingerprint(selected) !== key) return
      // Device keys deliberately cannot read the browser administration API.
      const endpoint = `${managedApiBase()}/api/cli/model-catalog?provider=openrouter`
      const response = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${selected.api_key}`,
          ...OpenScience.fundingHeaders(selected),
          "OpenScience-Catalog-Version": "2",
        },
        signal: controller.signal,
        redirect: "error",
      })
      await OpenScience.validateFundingResponse(response, selected)
      if (!response.ok) throw new Error("Model pricing request failed")
      const reader = response.body?.getReader()
      if (!reader) throw new Error("Model pricing response was empty")
      const decoder = new TextDecoder()
      let size = 0
      let text = ""
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 128 * 1024) {
          await reader.cancel()
          throw new Error("Model pricing response was too large")
        }
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
      const body = JSON.parse(text)
      const value = { prices: parse(body), availability: availability(body) }
      const current = await OpenScience.getFundingSnapshot()
      if (!current || fingerprint(current) !== key) return
      const changed =
        JSON.stringify(cached?.key === key ? cached.value : { prices: {}, availability: {} }) !== JSON.stringify(value)
      cached = { key, at: Date.now(), value }
      if (!changed) return
      const { Provider } = await import("./provider")
      Provider.invalidate()
      GlobalBus.emit("event", { directory: "global", payload: { type: "global.disposed", properties: {} } })
    } catch {
      const current = await OpenScience.getFundingSnapshot().catch(() => null)
      if (current && fingerprint(current) === key)
        cached = {
          key,
          at: Date.now() - TTL + 10_000,
          value: cached?.key === key ? cached.value : { prices: {}, availability: {} },
        }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Local session/cache reads only. Network refresh never blocks startup.
   * An explicit `force` (the user pressed Refresh) skips the TTL and the
   * post-failure cooldown and waits, within TIMEOUT, for the answer so the
   * caller's read reflects it. */
  export async function catalog(options: { force?: boolean } = {}): Promise<Catalog> {
    const snapshot = await OpenScience.getFundingSnapshot().catch(() => null)
    if (!snapshot) return { prices: {}, availability: {} }
    const key = fingerprint(snapshot)
    const due = cached?.key !== key || Date.now() - cached.at >= TTL
    if ((due || options.force) && pending?.key !== key) {
      const promise = refresh(snapshot, key)
      pending = { key, promise }
      void promise.finally(() => {
        if (pending?.promise === promise) pending = undefined
      })
    }
    if (options.force && pending?.key === key) await pending.promise
    return cached?.key === key ? cached.value : { prices: {}, availability: {} }
  }

  export async function current(options: { force?: boolean } = {}): Promise<Record<string, Model>> {
    return (await catalog(options)).prices
  }

  /** Fees belong to a served route, never to an account-wide default. */
  export function fundingFeeBps(
    model: {
      pricing?: { hosting_provider?: string; funding_fee_bps?: number }
      modes?: Record<string, { pricing?: { hosting_provider?: string; funding_fee_bps?: number } }>
    },
    tier?: string,
  ): number | undefined {
    const pricing = tier && tier !== "standard" ? model.modes?.[tier]?.pricing : model.pricing
    const host = Host.safeParse(pricing?.hosting_provider)
    const fee = Fee.safeParse(pricing?.funding_fee_bps)
    if (!host.success || !fee.success || (host.data !== "openrouter" && fee.data !== 0)) return
    return fee.data
  }

  /** Refresh unknown pricing once before any paid request, then fail explicitly. */
  export async function forRequest(model: Provider.Model, tier?: string): Promise<Provider.Model> {
    if (fundingFeeBps(model, tier) !== undefined) return model
    const price = (await current({ force: true }))[model.id]
    if (!price || fundingFeeBps(price, tier) === undefined) {
      throw new Error(
        "Ace pricing is unavailable for the selected model and speed. Refresh Models in Settings, then retry.",
      )
    }
    return { ...model, cost: price.cost, pricing: price.pricing, modes: price.modes }
  }

  function metadata(
    price: z.infer<typeof Price>,
    hosting: z.infer<typeof Host> | undefined,
    upstream: Model["pricing"]["upstream_provider"],
  ): Model["pricing"] | undefined {
    if (price.verified === false || (price.service_fee_bps !== undefined && price.service_fee_bps !== 0)) return
    if (price.hosting_provider && hosting && price.hosting_provider !== hosting) return
    const host = price.hosting_provider ?? hosting
    const pricing = { hosting_provider: host, funding_fee_bps: price.funding_fee_bps }
    const fee = fundingFeeBps({ pricing })
    if (!host || fee === undefined) return
    if (
      price.billing_basis &&
      price.billing_basis !== (host === "openrouter" ? "provider_reported_cost" : `${host}_token_usage`)
    )
      return
    return {
      upstream_provider: upstream,
      hosting_provider: host,
      funding_fee_bps: fee,
      ...(price.billing_basis ? { billing_basis: price.billing_basis } : {}),
      ...(price.audited_at ? { audited_at: price.audited_at } : {}),
      ...(price.source_url?.startsWith("https://") ? { source_url: price.source_url } : {}),
    }
  }
}
