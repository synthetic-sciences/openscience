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

/** The cap a model budgets when the person has not chosen one: the first
 * pricing boundary below the full window, where a tiered catalog raises every
 * input rate (mirrors the server's default), else the full window. */
export function modelDefaultContext(model: {
  limit: { context: number }
  contextOptions?: number[]
  cost: { tiers?: Array<{ threshold: number }>; experimentalOver200K?: unknown }
}) {
  const options = modelContextOptions(model)
  const thresholds = model.cost.tiers?.map((tier) => tier.threshold) ?? []
  const legacy = model.cost.experimentalOver200K ? [200_000] : []
  const boundary = [...thresholds, ...legacy]
    .filter((value) => value < model.limit.context && options.includes(value))
    .sort((a, b) => a - b)[0]
  return boundary ?? model.limit.context
}
