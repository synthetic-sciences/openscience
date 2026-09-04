import type { Message } from "@synsci/sdk/v2/client"
import { findLast } from "@synsci/util/array"
import { TokenUsage } from "@synsci/util/token-usage"

// Mirrors CompactionSettings.DEFAULT_WARN_TOKENS on the server; the effective value
// arrives through /settings/preferences and this only covers the window before it loads.
export const DEFAULT_WARN_TOKENS = 120_000

// One measurement of the conversation's size in tokens. `at` orders samples from the
// two sources: provider-reported usage on a finished assistant turn, and the pre-call
// composition estimate the server publishes as `session.context` while a turn is in
// flight (so the number moves during the long first-token wait, not only afterwards).
export type ContextSample = { total: number; at: number; source: "usage" | "estimate" }

export function usageSample(messages: Message[]): ContextSample | undefined {
  const last = findLast(messages, (message) => message.role === "assistant" && TokenUsage.total(message.tokens) > 0)
  if (!last || last.role !== "assistant") return undefined
  return { total: TokenUsage.total(last.tokens), at: last.time.completed ?? last.time.created, source: "usage" }
}

export function latestContext(messages: Message[], live?: ContextSample): ContextSample | undefined {
  const usage = usageSample(messages)
  if (!live) return usage
  if (!usage) return live
  return live.at > usage.at ? live : usage
}

// The notice is advisory and must never stack on top of a compaction already running.
export function contextWarning(input: { tokens?: number; warn: number; status?: string }) {
  if (input.tokens === undefined) return false
  if (input.status === "compacting") return false
  return input.tokens > input.warn
}

export function formatContextTokens(total: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(total)
}

// "128K"-style label for the header pill; the exact count lives in the tooltip.
export function compactContextTokens(total: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(total)
}
