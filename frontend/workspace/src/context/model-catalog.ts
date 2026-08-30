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
const GLM_PROVIDER_ALIASES = new Set(["zai", "opencode-go", "zai-coding-plan", "zhipuai-coding-plan"])

/** Ordered product roster for the composer. Missing entries are presentation-
 * only placeholders; this list never fabricates a callable provider route. */
export const COMPOSER_MODEL_ROSTER = [
  { key: "openai/gpt-5-6-sol", label: "5.6 Sol", provider: "openai" },
  { key: "openai/gpt-5-6-terra", label: "5.6 Terra", provider: "openai" },
  { key: "anthropic/claude-opus-5", label: "Opus 5", provider: "anthropic" },
  { key: "moonshotai/kimi-k3", label: "Kimi K3", provider: "moonshotai" },
  { key: "zai/glm-5-3", label: "GLM 5.3", provider: "zai" },
  { key: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek" },
  { key: "anthropic/claude-fable-5", label: "Fable 5", provider: "anthropic" },
  { key: "xai/grok-4-6", label: "Grok 4.6", provider: "xai" },
] as const

// Manage Models remains the one-time place for changing composer visibility.
// Keep the release's broader frontier defaults intact; the composer roster
// above only controls ordering and passive unavailable placeholders.
export const FRONTIER_MODELS: ReadonlySet<string> = new Set([
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
  "xai/grok-4-6",
  "xai/grok-4-20-multi-agent",
  "meta/muse-spark-1-1",
  "openai/gpt-5-5",
  "openai/gpt-5-5-pro",
  "openai/gpt-5-5-mini",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4-8",
  "google/gemini-3-6-flash",
  "google/gemini-3-1-pro-preview",
  "zai/glm-5-2",
  "zai/glm-5-3",
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
  if (GLM_PROVIDER_ALIASES.has(provider.id) && /^glm[-.]/i.test(modelID)) return { id: "zai", name: "Z.AI" }
  if (provider.id !== "openrouter") return provider
  const [vendor] = modelID.replace(/^~/, "").split("/")
  return OPENROUTER_VENDOR_DISPLAY[vendor?.toLowerCase() ?? ""] ?? provider
}

export type InferenceSource = "managed" | "byok" | "chatgpt"

/** Factual access route for a connected provider; ambiguous routes stay unlabeled. */
export function inferenceSource(input: {
  providerID: string
  credential: "env" | "synced" | "config" | "custom" | "api" | "managed"
  billing?: "managed" | "byok" | null
}): InferenceSource | undefined {
  if (input.providerID === "openai-codex") return "chatgpt"
  if (input.providerID === "openrouter" && input.credential === "managed") return "managed"
  if (input.credential === "api") return "byok"
  if (input.providerID === "openrouter") return input.billing === "byok" ? "byok" : undefined
  if (input.credential === "env" || input.credential === "synced" || input.credential === "config") return "byok"
  return undefined
}

export function inferenceSourceLabel(source: InferenceSource | undefined, fallback = "Provider") {
  if (source === "managed") return "Managed"
  if (source === "byok") return "BYOK"
  if (source === "chatgpt") return "ChatGPT"
  return fallback
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
  if (GLM_PROVIDER_ALIASES.has(vendor) && /^glm[-.]/i.test(base)) vendor = "zai"
  if (vendor === "z-ai" || vendor === "zhipuai") vendor = "zai"
  if (vendor === "x-ai") vendor = "xai"
  base = base.replace(/^~/, "").toLowerCase().replace(/\./g, "-")
  if (vendor === "anthropic") base = base.replace(/-\d{8}$/, "")
  return `${vendor}/${base}`
}

/**
 * Stable identity for a model in selection surfaces. Authentication remains a
 * route concern: the public OpenAI API and a ChatGPT/Codex subscription can
 * expose the same logical model without becoming duplicate model choices.
 */
export function logicalModelKey(providerID: string, modelID: string): string {
  let key = canonicalKey(providerID, modelID)
  if (key === "openai/gpt-5-6") key = "openai/gpt-5-6-sol"
  if (providerID === "openai-codex") key = key.replace(/^openai-codex\//, "openai/")
  return key
}

export const isFrontier = (model: ModelKey) =>
  FRONTIER_MODELS.has(canonicalKey(model.providerID, model.modelID)) ||
  FRONTIER_MODELS.has(logicalModelKey(model.providerID, model.modelID))

/** Display name for catalog aliases; exact provider/model ids are untouched. */
export function modelDisplayName(name: string, providerID: string, modelID: string): string {
  const key = logicalModelKey(providerID, modelID)
  const roster = COMPOSER_MODEL_ROSTER.find((model) => model.key === key)
  if (roster) return roster.label
  return name
}

export type CatalogModel = {
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

export type ModelRouteGroup<T extends CatalogModel> = {
  key: string
  model: T
  routes: T[]
}

const exactRouteKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`

export function modelRouteValue(model: ModelKey): string {
  return exactRouteKey(model)
}

export function parseModelRoute(value: string | undefined): ModelKey | undefined {
  if (!value) return undefined
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}

/**
 * Resolve a logical-model selection without changing authentication routes.
 * Exact choice wins, then the current provider route, then an unambiguous lone
 * route. Multiple unmatched routes deliberately return undefined so the UI can
 * ask which access route to use.
 */
export function preservedModelRoute<T extends CatalogModel>(routes: readonly T[], current?: ModelKey): T | undefined {
  if (current) {
    const exact = routes.find((route) => route.provider.id === current.providerID && route.id === current.modelID)
    if (exact) return exact
    const sameProvider = routes.find((route) => route.provider.id === current.providerID)
    if (sameProvider) return sameProvider
  }
  return routes.length === 1 ? routes[0] : undefined
}

/**
 * Collapse equivalent models for presentation while preserving every exact
 * provider/model route. The active route wins, then the most-recent exact
 * route, followed by a deterministic provider/id order. This keeps a user's
 * API-key or ChatGPT choice stable without showing two identical model rows.
 */
export function groupModelRoutes<T extends CatalogModel>(input: {
  models: readonly T[]
  current?: ModelKey
  recent?: readonly ModelKey[]
}): ModelRouteGroup<T>[] {
  const preference = new Map<string, number>()
  const ordered = [input.current, ...(input.recent ?? [])].filter((item): item is ModelKey => Boolean(item))
  for (const [index, item] of ordered.entries()) {
    const key = exactRouteKey(item)
    if (!preference.has(key)) preference.set(key, index)
  }

  const grouped = new Map<string, T[]>()
  for (const model of input.models) {
    const key = logicalModelKey(model.provider.id, model.id)
    grouped.set(key, [...(grouped.get(key) ?? []), model])
  }

  const rank = (model: T) => preference.get(exactRouteKey({ providerID: model.provider.id, modelID: model.id }))
  const fallback = (model: T) => {
    if (model.provider.id === "openai") return 0
    if (model.provider.id === "openai-codex") return 1
    return 2
  }
  const aliasFallback = (model: T) =>
    model.provider.id === "openai" && canonicalKey(model.provider.id, model.id) === "openai/gpt-5-6" ? 1 : 0

  return [...grouped.entries()].map(([key, routes]) => {
    routes.sort((left, right) => {
      const leftRank = rank(left)
      const rightRank = rank(right)
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1
        if (rightRank === undefined) return -1
        if (leftRank !== rightRank) return leftRank - rightRank
      }
      return (
        fallback(left) - fallback(right) ||
        left.provider.id.localeCompare(right.provider.id) ||
        aliasFallback(left) - aliasFallback(right) ||
        left.id.localeCompare(right.id)
      )
    })
    // The generic OpenAI GPT-5.6 id and its explicit Sol id are two exact API
    // ids for the same access path. Keep a current/recent generic route intact,
    // but never ask the user to choose between duplicate "OpenAI · API key"
    // rows. Different providers/authentication routes remain separate.
    const access = new Map<string, T>()
    for (const route of routes) {
      if (!access.has(route.provider.id)) access.set(route.provider.id, route)
    }
    const distinct = [...access.values()]
    return { key, model: distinct[0]!, routes: distinct }
  })
}

export function isChatModel(model: CatalogModel): boolean {
  if (/(^|\/)gemini-3-pro-image(?:-preview)?$/i.test(model.id)) return false
  if (/(^|[/._-])(?:text-)?embeddings?([/._-]|$)/i.test(model.id)) return false
  if (/(^|[/._-])embed([/._-]|$)/i.test(model.id)) return false
  const output = model.capabilities?.output
  if (!output) return true
  if (output.text === false) return false
  return !output.audio && !output.image && !output.video
}

export function isUserProviderConnection(input: {
  providerID: string
  source?: "env" | "synced" | "config" | "custom" | "api" | "managed"
  billing?: "managed" | "byok" | null
}): boolean {
  // Connected rows are account-backed credentials or keys explicitly saved in
  // this UI. Ambient shell variables and project/config providers can still be
  // used for inference, but they are not integrations and must not masquerade
  // as account state here.
  return input.source === "api" || input.source === "synced"
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
    // Models.dev sometimes ships both a stable alias and its dated Anthropic
    // snapshot on the same provider. Keep the stable id without collapsing a
    // native, subscription, or managed access route into another provider.
    return /-\d{8}$/.test(model.id) ? 0 : 1
  }

  for (const model of routed) {
    const key = `${model.provider.id}:${canonicalKey(model.provider.id, model.id)}`
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
