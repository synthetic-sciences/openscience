import type { ContextCompositionEstimate } from "@/components/session/context-composition"
import { modelDefaultContext } from "@/context/model-context"
import type { AssistantMessage, Message } from "@synsci/sdk/v2/client"
import { findLast } from "@synsci/util/array"
import { TokenUsage } from "@synsci/util/token-usage"

// One measurement of the conversation's size in tokens: provider-reported usage on a
// finished assistant turn, or the pre-call composition estimate the server publishes as
// `session.context` while a turn is in flight (so the number moves during the long
// first-token wait, not only afterwards).
export type ContextSample = { total: number; source: "usage" | "estimate"; composition?: ContextCompositionEstimate }

// A live estimate anchored to the id of the newest message the workspace held when it
// arrived. Message ids ascend, so a finished turn or compaction summary at or past
// `after` outranks the estimate without comparing the client's clock to the server's.
export type ContextEstimate = { total: number; after: string; composition?: ContextCompositionEstimate }

export function estimate(
  messages: Message[],
  total: number,
  composition?: ContextCompositionEstimate,
): ContextEstimate {
  return { total, after: messages[messages.length - 1]?.id ?? "", ...(composition ? { composition } : {}) }
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
  const saved = findLast(messages, (message) => message.role === "assistant" && Boolean(message.contextComposition))
  const snapshot =
    saved?.role === "assistant" && saved.contextComposition && (!last || saved.id >= last.id)
      ? { total: saved.contextComposition.total, after: saved.id, composition: saved.contextComposition }
      : undefined
  const current = live && (!snapshot || live.after > snapshot.after) ? live : snapshot
  const composition =
    current?.composition && (!last || last.id <= current.after) ? { composition: current.composition } : {}
  if (current && (!last || last.id < current.after)) return { total: current.total, source: "estimate", ...composition }
  const reported = sample(last)
  return reported ? { ...reported, ...composition } : undefined
}

type WindowModel = Parameters<typeof modelDefaultContext>[0]

/** The window the conversation is budgeted against. A tiered model such as
 * GPT-5.6 is capped at its first pricing boundary (272K) unless the person
 * chose the full window, and compaction fires against that cap; a percentage
 * of the raw 1M maximum would say 11% while the cap is nearly half used. */
export function contextWindow(messages: Message[], model: WindowModel | undefined) {
  const chosen = findLast(messages, (message) => message.role === "user" && typeof message.context === "number")
  const selected = chosen?.role === "user" ? chosen.context : undefined
  const full = model?.limit.context || undefined
  const window = selected ?? (model ? modelDefaultContext(model) : undefined) ?? full
  return {
    window: window || undefined,
    full,
    capped: full !== undefined && window !== undefined && window < full,
  }
}

export function formatContextTokens(total: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(total)
}

// "128K"-style label for the header pill; the exact count lives in the tooltip.
export function compactContextTokens(total: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(total)
}
