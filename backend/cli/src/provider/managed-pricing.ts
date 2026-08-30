import { createHash } from "node:crypto"
import z from "zod"
import { GlobalBus } from "@/bus/global"
import { API_BASE, OpenScience, type FundingSnapshot } from "@/openscience"
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
  pricing: z.object({
    tiers: z.array(Tier).min(1).max(8),
    audited_at: z.string().max(32).optional(),
    source_url: z.url().max(2048).optional(),
  }),
})

export namespace ManagedPricing {
  export type Model = {
    cost: {
      input: number
      output: number
      cache: { read: number; write: number }
      tiers?: Array<{ input: number; output: number; cache: { read: number; write: number }; threshold: number }>
    }
    pricing: { upstream_provider: z.infer<typeof Entry>["upstream_provider"]; audited_at?: string; source_url?: string }
    limit: { context: number; output?: number }
  }

  /** Whitelist non-executable metadata. Never accept remote API URLs, npm
   * packages, headers, keys, options, models, or authorization decisions. */
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
      result[model.id] = {
        cost: {
          ...cost(first),
          tiers: model.pricing.tiers
            .map((tier, index) => ({
              ...tier,
              threshold: model.pricing.tiers[index - 1]?.max_input_tokens ?? (tier.min_input_tokens ?? 1) - 1,
            }))
            .filter((tier) => tier.min_input_tokens !== undefined && tier.threshold > 0)
            .map((tier) => ({ ...cost(tier), threshold: tier.threshold }))
            .sort((a, b) => a.threshold - b.threshold),
        },
        pricing: {
          upstream_provider: model.upstream_provider,
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

  const fingerprint = (snapshot: FundingSnapshot) =>
    createHash("sha256")
      .update(`${snapshot.api_key}\0${snapshot.user_id}\0${snapshot.organization_id ?? "personal"}`)
      .digest("hex")
  let cached: { key: string; at: number; value: Record<string, Model> } | undefined
  let pending: { key: string; promise: Promise<void> } | undefined
  const TTL = 60_000
  const TIMEOUT = 3_000

  async function refresh(snapshot: FundingSnapshot, key: string) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT)
    try {
      // Device keys deliberately cannot read the browser administration API.
      const endpoint = `${API_BASE}/api/cli/model-catalog?provider=openrouter`
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${snapshot.api_key}`, ...OpenScience.fundingHeaders(snapshot) },
        signal: controller.signal,
        redirect: "error",
      })
      await OpenScience.validateFundingResponse(response, snapshot)
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
      const value = parse(JSON.parse(text))
      const current = await OpenScience.getFundingSnapshot()
      if (!current || fingerprint(current) !== key) return
      const changed = JSON.stringify(cached?.key === key ? cached.value : {}) !== JSON.stringify(value)
      cached = { key, at: Date.now(), value }
      if (!changed) return
      const { Provider } = await import("./provider")
      Provider.invalidate()
      GlobalBus.emit("event", { directory: "global", payload: { type: "global.disposed", properties: {} } })
    } catch {
      const current = await OpenScience.getFundingSnapshot().catch(() => null)
      if (current && fingerprint(current) === key)
        cached = { key, at: Date.now() - TTL + 10_000, value: cached?.key === key ? cached.value : {} }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Local session/cache reads only. Network refresh never blocks startup. */
  export async function current(): Promise<Record<string, Model>> {
    const snapshot = await OpenScience.getFundingSnapshot().catch(() => null)
    if (!snapshot) return {}
    const key = fingerprint(snapshot)
    if ((cached?.key !== key || Date.now() - cached.at >= TTL) && pending?.key !== key) {
      const promise = refresh(snapshot, key)
      pending = { key, promise }
      void promise.finally(() => {
        if (pending?.promise === promise) pending = undefined
      })
    }
    return cached?.key === key ? cached.value : {}
  }
}
