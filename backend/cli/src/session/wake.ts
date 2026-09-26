import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"

/** Delivering a detached result back to the session that asked for it.
 *
 * Work that outlives the turn which started it — a background worker, a
 * compute job — has no call left to return into. Its result arrives as a
 * synthetic user message and the loop answers that message, so the lead reads
 * the outcome instead of polling for it. */
export namespace SessionWake {
  const log = Log.create({ service: "session.wake" })

  /** The settings of the turn a wake continues. A report is not a new request,
   * so it carries the newest user message's effort, delegation settings
   * (autonomy, worker model), tools and system context. Left off, the loop
   * read the wake as a message with defaults for the rest of the run: the
   * lead's autonomy fell from autonomous to balanced (so it asked a "user"
   * that the headless run answered for it), and every later worker ran on the
   * lead's own model instead of the configured worker model. The deadline is
   * not copied: the budget unit anchors it to the message that set it. */
  export async function inherited(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role !== "user") continue
      const user = item.info
      return {
        effort: user.effort,
        delegation: user.delegation,
        delegationSettings: user.delegationSettings,
        tools: user.tools,
        system: user.system,
        variant: user.variant,
        tier: user.tier,
        context: user.context,
      }
    }
    return {}
  }

  /** Write the message, then make sure a loop answers it: a wake that lands as
   * the session's turn is ending can slip past that loop's final read, so run
   * the loop again until the message has a reply. */
  export async function deliver(input: {
    sessionID: string
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
    text: string
    describe: string
  }) {
    const settings = await inherited(input.sessionID)
    const message = await SessionPrompt.prompt({
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      ...settings,
      variant: input.variant ?? settings.variant,
      noReply: true,
      parts: [{ type: "text", synthetic: true, text: input.text }],
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      await SessionPrompt.loop(input.sessionID).catch(() => undefined)
      const messages = await Session.messages({ sessionID: input.sessionID })
      const answered = messages.some((item) => item.info.role === "assistant" && item.info.parentID === message.info.id)
      if (answered) return
    }
    log.warn("a detached completion was recorded but the session did not answer it", {
      sessionID: input.sessionID,
      what: input.describe,
    })
  }

  /** The model and agent of the turn a tool call belongs to, for a wake sent
   * after that turn has ended. */
  export async function origin(input: { sessionID: string; messageID: string; agent: string; variant?: unknown }) {
    const message = await MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID })
    if (message.info.role !== "assistant") return undefined
    return {
      sessionID: input.sessionID,
      agent: input.agent,
      model: { providerID: message.info.providerID, modelID: message.info.modelID },
      variant: typeof input.variant === "string" ? input.variant : undefined,
    }
  }
}
