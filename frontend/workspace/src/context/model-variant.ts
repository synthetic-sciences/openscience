export type ModelVariant = string

export function modelVariantOptions(variants: string[]): ModelVariant[] {
  if (variants.length === 0) return []
  return ["standard", ...new Set(variants.filter((variant) => variant !== "standard"))]
}

export function normalizedVariant(value: ModelVariant | undefined, variants: string[]): ModelVariant {
  const available = new Set(modelVariantOptions(variants))
  if (value && available.has(value)) return value
  return "standard"
}

export function promptVariant(value: ModelVariant | undefined, variants: string[]): ModelVariant | undefined {
  const normalized = normalizedVariant(value, variants)
  if (normalized === "standard") return undefined
  if (!variants.includes(normalized)) return undefined
  return normalized
}
