export type ModelTier = string

export function modelTierOptions(modes: string[]) {
  if (modes.length === 0) return []
  return ["standard", ...new Set(modes.filter((mode) => mode !== "standard"))].map((id) => ({ id, label: id }))
}

export function normalizedTier(value: ModelTier | undefined, modes: string[]): ModelTier {
  const available = new Set(modelTierOptions(modes).map((option) => option.id))
  if (value && available.has(value)) return value
  return "standard"
}

export function resolvedTier(value: ModelTier | undefined, modes: string[], fallback?: ModelTier): ModelTier {
  return normalizedTier(value ?? fallback, modes)
}

export function promptTier(value: ModelTier | undefined, modes: string[]): ModelTier | undefined {
  const normalized = normalizedTier(value, modes)
  if (normalized === "standard") return undefined
  if (!modes.includes(normalized)) return undefined
  return normalized
}
