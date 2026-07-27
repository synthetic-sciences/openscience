export type ModelKey = { providerID: string; modelID: string }
export type ModelProviderDisplay = { id: string; name: string }

const OPENROUTER_VENDOR_DISPLAY: Record<string, ModelProviderDisplay> = {
  anthropic: { id: "anthropic", name: "Anthropic" },
  openai: { id: "openai", name: "OpenAI" },
  google: { id: "google", name: "Google" },
  gemini: { id: "google", name: "Google" },
  "x-ai": { id: "xai", name: "xAI" },
  xai: { id: "xai", name: "xAI" },
  meta: { id: "meta", name: "Meta" },
  "meta-llama": { id: "llama", name: "Meta Llama" },
  deepseek: { id: "deepseek", name: "DeepSeek" },
  moonshotai: { id: "moonshotai", name: "Moonshot AI" },
  "z-ai": { id: "zai", name: "Z.AI" },
  zhipuai: { id: "zhipuai", name: "Zhipu AI" },
  zai: { id: "zai", name: "Z.AI" },
  mistralai: { id: "mistral", name: "Mistral" },
  qwen: { id: "openrouter", name: "Qwen" },
}

const OPENROUTER_PROVIDER_PREFIX: Record<string, string> = {
  gemini: "google",
  google: "google",
  xai: "x-ai",
  meta: "meta",
  zai: "z-ai",
  zhipuai: "z-ai",
}

const ANTHROPIC_DASHED_VERSION = /^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)(?:-\d{8})?$/

// The curated "frontier" set shown in the model picker by default. Everything
// else stays in the catalog and is one click away in Manage Models. Matched by
// canonicalKey() so a BYOK-native id and its managed OpenRouter vendor/model
// slug collapse to one entry.
export const FRONTIER_MODELS = new Set([
  "openai/gpt-5-6", // GPT-5.6 / Sol alias
  "openai/gpt-5-6-sol",
  "openai/gpt-5-6-sol-pro",
  "openai/gpt-5-6-terra",
  "openai/gpt-5-6-terra-pro",
  "openai/gpt-5-6-luna",
  "openai/gpt-5-6-luna-pro",
  "xai/grok-4-5",
  "xai/grok-4-20-multi-agent",
  "meta/muse-spark-1-1",
  "openai/gpt-5-5",
  "openai/gpt-5-5-pro",
  "openai/gpt-5-5-mini", // announced tier, not yet in the live catalog
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-fable-5",
  "google/gemini-3-6-flash",
  "google/gemini-3-1-pro-preview",
  "zai/glm-5-2",
  "moonshotai/kimi-k2-7-code",
  "moonshotai/kimi-k3",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
])

export function openrouterModelAlias(providerID: string, modelID: string): ModelKey | undefined {
  if (providerID === "openrouter") return undefined
  const vendor = OPENROUTER_PROVIDER_PREFIX[providerID] ?? providerID
  const base = modelID.replace(/^~/, "")
  if (!vendor || !base) return undefined
  const normalized = vendor === "anthropic" ? base.replace(ANTHROPIC_DASHED_VERSION, "$1.$2") : base
  const alias = providerID === "openai" && base === "gpt-5.6" ? "gpt-5.6-sol" : normalized
  return { providerID: "openrouter", modelID: `${vendor}/${alias}` }
}

export function routableModelKey(model: ModelKey, hasModel: (model: ModelKey) => boolean): ModelKey {
  if (hasModel(model)) return model
  const alias = openrouterModelAlias(model.providerID, model.modelID)
  if (alias && hasModel(alias)) return alias
  return model
}

export function displayProviderForModel(provider: ModelProviderDisplay, modelID: string): ModelProviderDisplay {
  if (provider.id !== "openrouter") return provider
  const [vendor] = modelID.replace(/^~/, "").split("/")
  return OPENROUTER_VENDOR_DISPLAY[vendor?.toLowerCase() ?? ""] ?? provider
}

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
