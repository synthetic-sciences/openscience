import z from "zod"
import { API_BASE, OpenScience, type FundingSnapshot, type ResearchSearchInput } from "@/openscience"
import { FirecrawlSearch } from "./firecrawl"

export namespace ResearchSearch {
  const Response = z.object({
    operation_id: z.string(),
    status: z.literal("completed"),
    provider: z.string(),
    funding: z.enum(["wallet", "legacy_allowance", "free_fallback"]),
    results: z.array(z.object({ url: z.string().url() }).passthrough()),
    warnings: z.array(z.string()).optional(),
    wallet_charge_microusd: z.number().int().nonnegative().optional(),
    provider_usage_pending: z.boolean().optional(),
    search_details: z
      .object({
        source: z.enum(["web", "research", "news", "developer"]),
        mode: z.enum(["fast", "balanced", "deep"]),
        requested_limit: z.number().int().nonnegative(),
        effective_limit: z.number().int().nonnegative(),
        returned_count: z.number().int().nonnegative(),
        content_requested: z.boolean(),
        enriched_count: z.number().int().nonnegative(),
        ranking: z.literal("provider"),
        date_filter: z.enum(["none", "publication_date_required"]),
        domain_filter: z.enum(["none", "enforced"]),
      })
      .optional(),
  })

  export async function search(
    input: ResearchSearchInput,
    options: {
      key?: string
      snapshot?: FundingSnapshot | null
      operationID: string
      signal: AbortSignal
      fetch?: typeof globalThis.fetch
      baseURL?: string
      timeoutMs?: number
    },
  ) {
    // An explicitly connected personal key always stays on that account.
    // Never retry a failed BYOK request against the managed Wallet.
    if (options.key) return FirecrawlSearch.search(input, { ...options, key: options.key })
    if (!options.snapshot) return undefined
    const snapshot = options.snapshot
    const response = await (options.fetch ?? globalThis.fetch)(
      `${(options.baseURL ?? API_BASE).replace(/\/+$/, "")}/api/v1/research/search`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${snapshot.api_key}`,
          ...OpenScience.fundingHeaders(snapshot),
          "Content-Type": "application/json",
          "Idempotency-Key": options.operationID,
        },
        body: JSON.stringify({ ...input, operation_id: options.operationID }),
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)]),
      },
    )
    await OpenScience.validateFundingResponse(response, snapshot)
    if (!response.ok) throw new Error(`Ace search failed with HTTP ${response.status}. No other account was used.`)
    const result = Response.parse(await response.json())
    OpenScience.invalidateBalance()
    return result
  }
}
