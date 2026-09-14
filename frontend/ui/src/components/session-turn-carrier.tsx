import type { Message, Part, UserMessage } from "@synsci/sdk/v2/client"

/**
 * A user message the runtime wrote to keep a turn going: a harness or loop
 * continuation, or a background worker's completion carrying the `<task>`
 * envelope. Nobody typed it, so it opens no turn of its own; the work that
 * answers it belongs to the turn the user actually started. A compaction
 * carrier is not one of these (it draws its own boundary), and neither is a
 * shell-mode command, whose synthetic text is the user's own action.
 */
export function isContinuationCarrier(message: Message, parts: readonly Part[] | undefined): boolean {
  if (message.role !== "user") return false
  const internal = (message as UserMessage).internal
  if (internal?.type === "continuation") return true
  if (internal?.type === "compaction") return false
  if (!parts?.length) return false
  const texts = parts.filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
  return (
    texts.length === parts.length &&
    texts.every((part) => part.synthetic) &&
    texts.some((part) => /^\s*<task\b/.test(part.text))
  )
}

/** The user message that opened the turn a message belongs to: itself for a
 * real request, the nearest earlier real request for a carrier. */
export function turnOpener(
  messages: readonly Message[],
  index: number,
  parts: (id: string) => readonly Part[] | undefined,
): Message | undefined {
  for (let i = index; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== "user") continue
    if (!isContinuationCarrier(message, parts(message.id))) return message
  }
  return undefined
}
