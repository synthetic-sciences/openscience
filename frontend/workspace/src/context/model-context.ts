/** Context caps are local compaction budgets, not provider model variants.
 * Offer only this route's published caps or actual pricing boundaries. */
export function modelContextOptions(model: {
  limit: { context: number }
  contextOptions?: number[]
  cost: { tiers?: Array<{ threshold: number }>; experimentalOver200K?: unknown }
}) {
  const thresholds = model.cost.tiers?.map((tier) => tier.threshold) ?? []
  const legacy = model.cost.experimentalOver200K ? [200_000] : []
  return [...new Set([...(model.contextOptions ?? [...thresholds, ...legacy]), model.limit.context])]
    .filter((value) => Number.isFinite(value) && value > 0 && value <= model.limit.context)
    .sort((a, b) => a - b)
}
