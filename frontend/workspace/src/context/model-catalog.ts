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
  "openai-codex/gpt-5-4",
  "openai-codex/gpt-5-5",
  "openai-codex/gpt-5-6-luna",
  "openai-codex/gpt-5-6-sol",
  "openai-codex/gpt-5-6-terra",
  "xai/grok-4-5",
  "xai/grok-4-20-multi-agent",
  "meta/muse-spark-1-1",
  "openai/gpt-5-5",
  "openai/gpt-5-5-pro",
  "openai/gpt-5-5-mini", // announced tier, not yet in the live catalog
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-4-8",
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
  if (provider.id === "openai-codex") return { id: "openai", name: "OpenAI" }
  if (provider.id !== "openrouter") return provider
  const [vendor] = modelID.replace(/^~/, "").split("/")
  return OPENROUTER_VENDOR_DISPLAY[vendor?.toLowerCase() ?? ""] ?? provider
}

export function modelContext(limit: number): string {
  if (limit >= 1_000_000) {
    const value = limit / 1_000_000
    const rounded = Math.abs(value - Math.round(value)) < 0.1 ? Math.round(value) : Number(value.toFixed(1))
    return `${rounded.toLocaleString()}m`
  }
  if (limit >= 1_000) return `${Math.round(limit / 1_000).toLocaleString()}k`
  return limit.toLocaleString()
}

export function modelSummary(input: { reasoning: boolean; context: number; provider: string }): string {
  return `${input.reasoning ? "Reasoning" : "General"} · ${modelContext(input.context)} context · ${input.provider}`
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
  if (vendor === "anthropic") base = base.replace(/-\d{8}$/, "")
  return `${vendor}/${base}`
}

type CatalogModel = {
  id: string
  provider: { id: string }
  modes?: Record<string, unknown>
  capabilities?: {
    output?: {
      text?: boolean
      audio?: boolean
      image?: boolean
      video?: boolean
    }
  }
}

export function isChatModel(model: CatalogModel): boolean {
  if (/(^|[/._-])(?:text-)?embeddings?([/._-]|$)/i.test(model.id)) return false
  if (/(^|[/._-])embed([/._-]|$)/i.test(model.id)) return false
  const output = model.capabilities?.output
  if (!output) return true
  if (output.text === false) return false
  return !output.audio && !output.image && !output.video
}

export function isUserProviderConnection(input: {
  providerID: string
  source?: "env" | "config" | "custom" | "api" | "managed"
  billing?: "managed" | "byok" | null
}): boolean {
  if (input.providerID !== "openrouter") return true
  // "managed" means the Atlas proxy is carrying this route. That is not a
  // connection the reader set up, so it has no place in a panel about their own
  // keys — it falls through to the billing check and is filtered out. Which
  // credential is paying remains an account-level concern rather than being
  // repeated beside every model name in the composer.
  if (input.source === "api") return true
  return input.billing === "byok"
}

export function foldedRouteMode(model: ModelKey, target: CatalogModel): string | undefined {
  if (model.providerID !== "openrouter" || target.provider.id !== model.providerID) return undefined
  const match = model.modelID.match(/-(fast)$/)
  if (!match) return undefined
  const mode = match[1]
  const base = model.modelID.slice(0, -match[0].length)
  if (target.id !== base || !target.modes?.[mode]) return undefined
  return mode
}

export function preferredModels<T extends CatalogModel>(models: T[]): T[] {
  const routed = models.filter((model) => {
    if (model.provider.id !== "openrouter") return true
    const match = model.id.match(/-(fast)$/)
    if (!match) return true
    const mode = match[1]
    const base = model.id.slice(0, -match[0].length)
    return !models.some(
      (candidate) => candidate.provider.id === model.provider.id && candidate.id === base && !!candidate.modes?.[mode],
    )
  })

  const result: T[] = []
  const seen = new Map<string, number>()
  const score = (model: T) => {
    // Synced managed routes are removed by the backend in explicit BYOK mode.
    // When both survive in auto mode, prefer the managed OpenRouter route so a
    // stale native key cannot shadow the healthy wallet route.
    const route = model.provider.id === "openrouter" ? 2 : 0
    // Models.dev sometimes ships both a stable alias and its dated Anthropic
    // snapshot under the same display name. Keep the stable id.
    const stable = /-\d{8}$/.test(model.id) ? 0 : 1
    return route + stable
  }

  for (const model of routed) {
    const key = canonicalKey(model.provider.id, model.id)
    const index = seen.get(key)
    if (index === undefined) {
      seen.set(key, result.length)
      result.push(model)
      continue
    }
    if (score(model) > score(result[index])) result[index] = model
  }
  return result
}

export function preferredModel<T extends CatalogModel>(models: T[], key: ModelKey): T | undefined {
  const exact = (candidate: ModelKey) =>
    models.find((model) => model.provider.id === candidate.providerID && model.id === candidate.modelID)
  const found = exact(key)
  if (found) return found

  const folded = models.find((model) => foldedRouteMode(key, model))
  if (folded) return folded

  const routed = routableModelKey(key, (candidate) => !!exact(candidate))
  const alias = exact(routed)
  if (alias) return alias

  const canonical = canonicalKey(key.providerID, key.modelID)
  return models.find((model) => canonicalKey(model.provider.id, model.id) === canonical)
}

export const isFrontier = (model: ModelKey) => FRONTIER_MODELS.has(canonicalKey(model.providerID, model.modelID))
