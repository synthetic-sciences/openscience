import z from "zod"

export namespace UsageEvidence {
  const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()

  export const Reported = z.object({
    input_tokens: Count,
    output_tokens: Count,
    total_tokens: Count,
    reasoning_tokens: Count,
    cached_input_tokens: Count,
    cache_creation_input_tokens: Count,
  })

  export const Source = z.enum([
    "subscription",
    "provider_response",
    "wallet_calculated",
    "catalog_estimate",
    "unknown",
  ])

  export const Cost = z.object({
    source: Source,
    amountUSD: z.number().finite().nonnegative().nullable(),
  })
}
