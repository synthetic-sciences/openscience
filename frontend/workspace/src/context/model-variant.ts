export type ModelVariant = string

export function modelVariantDefault(model: { id: string; reasoningOptions?: Array<Record<string, unknown>> }) {
  const effort = model.reasoningOptions?.find((option) => option.type === "effort")
  if (typeof effort?.default === "string") return effort.default
  // Native and OpenRouter Grok share this documented default. Omitting the
  // parameter is not the same as turning reasoning off (which Grok rejects).
  if (/(^|\/)grok-4[.-](5|6)\b/.test(model.id)) return "high"
  if (/deepseek-v4\b/.test(model.id)) return "high"
  if (/glm-5[.-]3\b|kimi-k3\b/.test(model.id)) return "max"
  return undefined
}

export function modelVariantOptions(variants: string[], fallback?: string): ModelVariant[] {
  if (variants.length === 0) return []
  const available = [...new Set(variants.filter((variant) => variant !== "standard" && variant !== "default"))]
  return fallback && available.includes(fallback) ? available : ["default", ...available]
}

export function normalizedVariant(
  value: ModelVariant | undefined,
  variants: string[],
  fallback?: string,
): ModelVariant {
  const available = new Set(modelVariantOptions(variants, fallback))
  if (value && available.has(value)) return value
  return fallback && available.has(fallback) ? fallback : "default"
}

export function promptVariant(
  value: ModelVariant | undefined,
  variants: string[],
  fallback?: string,
): ModelVariant | undefined {
  const normalized = normalizedVariant(value, variants, fallback)
  if (normalized === "default") return undefined
  if (!variants.includes(normalized)) return undefined
  return normalized
}
