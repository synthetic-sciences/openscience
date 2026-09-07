import type { AssistantMessage, Message, Part } from "@synsci/sdk/v2/client"

export type ContextCategory = "instructions" | "user" | "assistant" | "tool"

/** The loaded transcript can describe available text, not the complete provider
 * payload. Keep this estimate independent of provider usage and its cache split. */
export function contextComposition(
  messages: Message[],
  parts: Record<string, Part[] | undefined>,
  call: AssistantMessage,
) {
  const end = messages.findIndex((message) => message.id === call.id)
  if (end < 0 || call.summary) return []
  const prior = messages.slice(0, end)
  const summary = prior.findLast(
    (message): message is AssistantMessage =>
      message.role === "assistant" &&
      message.summary === true &&
      Boolean(message.finish && message.finish !== "compact" && message.finish !== "length" && !message.error) &&
      (parts[message.id] ?? []).some((part) => part.type === "text" && part.text.trim()),
  )
  const carrier = summary
    ? prior.findIndex(
        (message) =>
          message.id === summary.parentID && (parts[message.id] ?? []).some((part) => part.type === "compaction"),
      )
    : -1
  const tail = summary?.tailStartId ? prior.findIndex((message) => message.id === summary.tailStartId) : -1
  const start = carrier < 0 ? 0 : tail >= 0 && tail < carrier ? tail : carrier
  const parent = prior.find((message) => message.id === call.parentID)
  const chars: Record<ContextCategory, number> = {
    instructions: parent?.role === "user" ? (parent.system?.length ?? 0) : 0,
    user: 0,
    assistant: 0,
    tool: 0,
  }

  for (const message of prior.slice(start)) {
    for (const part of parts[message.id] ?? []) {
      if (part.type === "text" && !part.ignored) chars[message.role] += part.text.length
      if (part.type !== "tool") continue
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      chars.tool += part.tool.length + JSON.stringify(part.state.input).length
      if (part.state.status === "error") chars.tool += part.state.error.length
      if (part.state.status === "completed" && !part.state.time.compacted) chars.tool += part.state.output.length
    }
  }

  const entries = (Object.entries(chars) as Array<[ContextCategory, number]>).map(([key, count]) => ({
    key,
    tokens: Math.ceil(count / 4),
  }))
  const total = entries.reduce((sum, entry) => sum + entry.tokens, 0)
  return entries.filter((entry) => entry.tokens > 0).map((entry) => ({ ...entry, share: entry.tokens / total }))
}
