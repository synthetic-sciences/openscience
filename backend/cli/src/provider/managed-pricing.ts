import { createHash } from "node:crypto"
import z from "zod"
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
const Entry = z.object({
  id: z.string(),
  available: z.boolean().optional(),
  upstream_provider: z.enum(["anthropic", "gemini", "xai", "meta", "openrouter"]),
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
      transport: z
        .union([z.object({ service_tier: z.literal("priority") }), z.object({ speed: z.literal("fast") })])
        .optional(),
      pricing: z.object({ verified: z.boolean().optional(), tiers: z.array(Tier).min(1).max(8) }).optional(),
    })
    .optional(),
  pricing: z.object({
    tiers: z.array(Tier).min(1).max(8),
    audited_at: z.string().max(32).optional(),
    source_url: z.url().max(2048).optional(),
    funding_fee_bps: z.number().int().min(0).max(10_000).optional(),
  }),
})

export namespace ManagedPricing {
  export type Catalog = { prices: Record<string, Model>; availability: Record<string, boolean> }

  /** The Wallet debit for an Ace turn is the gateway's reported OpenRouter
   * cost plus this funding fee and nothing else; the server may state its own. */
  export const DEFAULT_FUNDING_FEE_BPS = 550

  export type Model = {
    cost: {
      input: number
      output: number
      cache: { read: number; write: number }
      tiers?: Array<{ input: number; output: number; cache: { read: number; write: number }; threshold: number }>
    }
    pricing: {
      upstream_provider: z.infer<typeof Entry>["upstream_provider"]
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
      const body: Record<string, string> | undefined =
        model.upstream_provider === "openrouter" &&
        /^openai\/(?:gpt-5\.6-(?:sol|terra|luna)|gpt-6-astra)$/.test(model.id) &&
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
          model.fast_mode && fast?.available && fast.pricing?.verified === true && premium && body
            ? {
                fast: {
                  cost: { ...cost(premium), tiers: tiers(fast.pricing.tiers) },
                  provider: { body },
                },
              }
            : {},
        cost: {
          ...cost(first),
          tiers: tiers(model.pricing.tiers),
        },
        pricing: {
          upstream_provider: model.upstream_provider,
          funding_fee_bps: model.pricing.funding_fee_bps ?? DEFAULT_FUNDING_FEE_BPS,
          audited_at: model.pricing.audited_at,
          ...(model.pricing.source_url?.startsWith("https://") ? { source_url: model.pricing.source_url } : {}),
        },
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
        headers: { Authorization: `Bearer ${selected.api_key}`, ...OpenScience.fundingHeaders(selected) },
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

  /** The fee the Wallet adds to a reported cost for this model. A route whose
   * catalog entry has not loaded is still charged the fee, so the default
   * applies rather than zero. */
  export function fundingFeeBps(model: { pricing?: { funding_fee_bps?: number } }): number {
    return model.pricing?.funding_fee_bps ?? DEFAULT_FUNDING_FEE_BPS
  }

  /** The funding fee as a percentage for product copy, from the catalog
   * already held for the signed-in account (one fee applies to every model
   * in it). Never starts a network read. */
  export async function fundingFeePercent(): Promise<number> {
    const snapshot = await OpenScience.getFundingSnapshot().catch(() => null)
    const prices = snapshot && cached?.key === fingerprint(snapshot) ? cached.value.prices : {}
    const first = Object.values(prices)[0]
    return (first ? fundingFeeBps(first) : DEFAULT_FUNDING_FEE_BPS) / 100
  }
}
