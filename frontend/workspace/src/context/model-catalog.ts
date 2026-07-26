export type ModelKey = { providerID: string; modelID: string }

// The curated "frontier" set shown in the model picker by default. Everything
// else stays in the catalog and is one click away in Manage Models. Matched by
// canonicalKey() so a BYOK-native id and its managed OpenRouter vendor/model
// slug collapse to one entry.
export const FRONTIER_MODELS = new Set([
  "openai/gpt-5-6", // GPT-5.6 / Sol alias
  "openai/gpt-5-6-sol",
  "openai/gpt-5-6-terra",
  "openai/gpt-5-6-luna",
  "xai/grok-4-5",
  "meta/muse-spark-1-1",
  "openai/gpt-5-5",
  "openai/gpt-5-5-mini", // announced tier, not yet in the live catalog
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-fable-5",
  "zai/glm-5-2",
  "moonshotai/kimi-k2-7-code",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
])

/** Stable key shared by native ids and OpenRouter vendor/model slugs. */
export function canonicalKey(providerID: string, modelID: string): string {
  let vendor = providerID
  let base = modelID
  const slash = modelID.lastIndexOf("/")
  if (slash >= 0) {
    vendor = modelID.slice(0, slash)
    base = modelID.slice(slash + 1)
  }
  vendor = vendor.replace(/^~/, "").toLowerCase()
  if (vendor === "z-ai" || vendor === "zhipuai") vendor = "zai"
  if (vendor === "x-ai") vendor = "xai"
  base = base.replace(/^~/, "").toLowerCase().replace(/\./g, "-")
  return `${vendor}/${base}`
}

export const isFrontier = (model: ModelKey) => FRONTIER_MODELS.has(canonicalKey(model.providerID, model.modelID))
