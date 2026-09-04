import { createSignal } from "solid-js"
import type { AssistantMessage, Message } from "@synsci/sdk/v2/client"
import { findLast } from "@synsci/util/array"
import { TokenUsage } from "@synsci/util/token-usage"

// Mirrors CompactionSettings.DEFAULT_WARN_TOKENS on the server; the effective value
// arrives through /settings/preferences and this only covers the window before it loads.
export const DEFAULT_WARN_TOKENS = 120_000

const [warn, setWarn] = createSignal(DEFAULT_WARN_TOKENS)

// Effective `compaction.warn_tokens`. The session page compares the live conversation
// size against it, and Customize → General publishes each confirmed write here so an
// open session re-evaluates its notice without a reload.
export const warnTokens = {
  value: warn,
  sync(preferences: { compaction_warn_tokens?: number }) {
    const value = preferences.compaction_warn_tokens
    if (value === undefined || !(value > 0)) return
    setWarn(value)
  },
}

// One measurement of the conversation's size in tokens: provider-reported usage on a
// finished assistant turn, or the pre-call composition estimate the server publishes as
// `session.context` while a turn is in flight (so the number moves during the long
// first-token wait, not only afterwards).
export type ContextSample = { total: number; source: "usage" | "estimate" }

// A live estimate anchored to the id of the newest message the workspace held when it
// arrived. Message ids ascend, so a finished turn or compaction summary at or past
// `after` outranks the estimate without comparing the client's clock to the server's.
export type ContextEstimate = { total: number; after: string }

export function estimate(messages: Message[], total: number): ContextEstimate {
  return { total, after: messages[messages.length - 1]?.id ?? "" }
}

// The newest assistant message that settles the conversation's size: a finished turn
// with reported usage, or a compaction summary. The summary's own usage describes the
// head it just replaced, so it is a boundary rather than a sample: nothing before it
// counts, and nothing is known until the next turn reports.
function settled(messages: Message[]): AssistantMessage | undefined {
  const last = findLast(
    messages,
    (message) => message.role === "assistant" && (message.summary === true || TokenUsage.total(message.tokens) > 0),
  )
  if (!last || last.role !== "assistant") return undefined
  return last
}

function sample(last: AssistantMessage | undefined): ContextSample | undefined {
  if (!last || last.summary) return undefined
  return { total: TokenUsage.total(last.tokens), source: "usage" }
}

export function usageSample(messages: Message[]): ContextSample | undefined {
  return sample(settled(messages))
}

export function latestContext(messages: Message[], live?: ContextEstimate): ContextSample | undefined {
  const last = settled(messages)
  if (live && (!last || last.id < live.after)) return { total: live.total, source: "estimate" }
  return sample(last)
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
