/**
 * Shared, provider-agnostic helpers for model pricing + credential source.
 *
 * `cost` comes straight off a models.dev model record (`model.cost`) and is
 * denominated in USD per **million** tokens. All values are optional because
 * local/free/zero-cost models omit them.
 */

export interface ModelCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
}

/**
 * A model is "free" when it has no cost record, or its input+output rates are
 * both zero. Covers OpenRouter `:free`, local/Ollama, managed zero-cost demo
 * models, and anything else that never bills — no provider hardcoding.
 */
export function isFreeCost(cost?: ModelCost | null): boolean {
  if (!cost) return true
  return (cost.input ?? 0) === 0 && (cost.output ?? 0) === 0
}

/** Format a $/M-tokens rate compactly, e.g. `$3/M`, `$0.15/M`, `free`. */
export function formatRate(value?: number): string {
  if (value === undefined || value === null) return "—"
  if (value === 0) return "$0"
  const rounded = value >= 1 ? value.toFixed(2).replace(/\.00$/, "") : value.toPrecision(2)
  return `$${rounded}`
}

export interface PricingLines {
  free: boolean
  input?: string
  output?: string
  cache?: string
}

/** Build the per-token pricing lines shown in pickers + tooltips. */
export function pricingLines(cost?: ModelCost | null): PricingLines {
  if (isFreeCost(cost)) return { free: true }
  const input = formatRate(cost!.input)
  const output = formatRate(cost!.output)
  const read = cost!.cache_read
  const write = cost!.cache_write
  const cache =
    read !== undefined || write !== undefined ? `${formatRate(read ?? 0)} / ${formatRate(write ?? 0)}` : undefined
  return { free: false, input, output, cache }
}

/**
 * Where a model's credential comes from, used for the composer source badge.
 * This is a best-effort inference from the provider connection state the web
 * app already has; the authoritative resolver lives server-side (workstream
 * iii) and can be threaded through here once its route is exposed.
 */
export type ModelSource = "managed" | "signed-in" | "byok"

/** Managed (metered / wallet-debiting) providers reached through the Atlas seam. */
const MANAGED_PROVIDERS = new Set(["synsci"])

export interface SourceInput {
  providerID: string
  connected: boolean
  /** Available auth methods for the provider (from `provider.auth()`). */
  authMethods?: Array<{ type: "oauth" | "api" }>
}

export function resolveModelSource(input: SourceInput): ModelSource {
  if (MANAGED_PROVIDERS.has(input.providerID)) return "managed"
  const methods = input.authMethods ?? []
  const hasOauth = methods.some((m) => m.type === "oauth")
  const hasApi = methods.some((m) => m.type === "api")
  // OAuth-only connected providers (Copilot, Codex, Claude Pro/Max) are signed-in.
  if (hasOauth && !hasApi) return "signed-in"
  return "byok"
}
