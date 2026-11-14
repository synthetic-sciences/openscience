import { Session } from "@/session"

/**
 * The text the person typed in a session's first request: the anchor for the
 * acceptance contract and the deliverables, which later turns may steer but
 * never redefine. Read from the stored transcript, so a process that restarts
 * mid-session finds the same anchor its predecessor read from the live
 * message. Undefined for a worker, whose brief is the lead's, and for a
 * session the person has not written in yet.
 */
export async function firstRequest(sessionID: string): Promise<string | undefined> {
  const session = await Session.get(sessionID).catch(() => undefined)
  if (!session || session.parentID) return
  const messages = await Session.messages({ sessionID }).catch(() => [])
  const first = messages.find(
    (message) =>
      message.info.role === "user" &&
      message.info.internal?.type !== "continuation" &&
      message.parts.some((part) => part.type === "text" && !part.synthetic),
  )
  if (!first) return
  return first.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}
