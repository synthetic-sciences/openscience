import type { Hooks, Plugin } from "@synsci/plugin"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionLoopState } from "@/session/loop-state"
import { HarnessState } from "./state"

/**
 * An unattended run does not end on a question. Under `autonomous` autonomy
 * there is no one to answer, upload or confirm; a final answer that asks the
 * user for something is a turn abandoned with the budget unused and the
 * outputs unwritten. Once per session the harness answers instead: proceed
 * on the inputs as supplied, state the assumption, deliver. Mechanical and
 * model-agnostic; it reads the model's own final text and nothing about the
 * task.
 */
export namespace Unattended {
  /** Phrasings that hand the next move to a person: a request to upload,
   * provide, confirm or choose, or a wait for something the user would
   * send. Matched on the final text with code removed, so a script or a
   * command the model quotes never counts. */
  const ASKS = [
    /\b(?:please|kindly)\s+(?:re-?)?(?:upload|provide|send|share|supply|attach|confirm|specify|clarify|choose|select|advise)\b/i,
    /\b(?:could|can|would|will)\s+you(?:\s+please)?\s+(?:re-?)?(?:upload|provide|send|share|supply|attach|confirm|specify|clarify|choose|select|tell\s+me|let\s+me\s+know)\b/i,
    /\b(?:awaiting|waiting\s+(?:on|for))\s+(?:your|the\s+corrected|corrected|updated|revised|the\s+(?:updated|revised|correct(?:ed)?))\b/i,
    /\bonce\s+you\s+(?:re-?)?(?:upload|provide|send|share|confirm|supply)\b/i,
    /\bI\s+need\s+(?:you\s+to|the\s+corrected|corrected|updated|revised)\b/i,
    /\b(?:let\s+me\s+know|tell\s+me)\s+(?:which|whether|if|how|what|when)\b/i,
    /\b(?:which|what)\s+(?:would|do)\s+you\s+(?:prefer|want|like)\b/i,
    /\b(?:do|would)\s+you\s+want\s+me\s+to\b/i,
    /\bshould\s+I\s+(?:proceed|continue|use|wait|assume)\b[^.?!\n]*\?/i,
  ]

  /** Whether a final answer is a request to the user. Code and quoted
   * strings are mentions, not requests: a validator that prints "please
   * upload" is being described, not spoken. */
  export function asksTheUser(text: string) {
    const prose = text
      .replace(/^\s*(?:```|~~~)[^\n]*\n[\s\S]*?^\s*(?:```|~~~)[^\n]*$/gm, " ")
      .replace(/`[^`\n]*`/g, " ")
      .replace(/(["'])(?:(?!\1)[^\n]){1,80}\1/g, " ")
    return ASKS.some((pattern) => pattern.test(prose))
  }

  export type Decision = {
    autonomy: MessageV2.DelegationSettings["autonomy"]
    root: boolean
    rounds: number
    finalText: string
    /** Whether the turn called any tool before its final answer. */
    worked: boolean
  }

  /** The continuation, or nothing: only an unattended root session, only
   * once, and only when the final answer hands the next move to a person.
   * A turn that asks before doing any work may have been given no task at
   * all ("hey"), so it is told to stop when there is none rather than to
   * deliver; a turn that worked and then stalled is told to deliver. */
  export function decide(input: Decision) {
    if (input.autonomy !== "autonomous" || !input.root || input.rounds >= 1) return
    if (!asksTheUser(input.finalText)) return
    return input.worked ? render() : renderUnstarted()
  }

  export function render() {
    return [
      "No one is available to answer in this run, and nothing will be uploaded, corrected or confirmed.",
      "Proceed on the inputs exactly as supplied: state the assumption you are making, in the trace and in the report, and deliver every output the task asks for.",
      "Where two readings of an input remain, deliver under the reading the supplied files themselves support and record the alternative beside it. A run that ends on a question has delivered nothing.",
    ].join(" ")
  }

  export function renderUnstarted() {
    return [
      "No one is available to answer in this run, and nothing will be uploaded, corrected or confirmed.",
      "If the user's message asks for work, proceed on the inputs exactly as supplied: inspect them, state the assumption you are making, and deliver every output the task asks for.",
      "If it asks for no work (a greeting, thanks or small talk), there is nothing to deliver: reply in one short line and end the turn without calling tools.",
    ].join(" ")
  }
}

export const UnattendedUnit: Plugin = async () => {
  const hooks: Hooks = {
    async "loop.before_finish"(input, output) {
      // Another unit already has the floor this round; a missing deliverable
      // or a failing acceptance check is the more specific thing to say.
      if (output.message) return
      const state = HarnessState.get(input.sessionID)
      if (state.unattendedRounds >= 1) return
      const session = await Session.get(input.sessionID).catch(() => undefined)
      if (!session) return
      const messages = await Session.messages({ sessionID: input.sessionID }).catch(() => [])
      const user = [...messages].reverse().find((message) => message.info.role === "user")?.info
      if (!user || user.role !== "user") return
      const settings = MessageV2.resolveDelegationSettings(user.delegationSettings, {
        effort: user.effort,
        enabled: user.delegation,
      })
      const worked = SessionLoopState.epochMessages(messages).some(
        (message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "tool"),
      )
      const final = messages.find((message) => message.info.id === input.messageID)
      const finalText = (final?.parts ?? [])
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
      const message = Unattended.decide({
        autonomy: settings.autonomy,
        root: !session.parentID,
        rounds: state.unattendedRounds,
        finalText,
        worked,
      })
      if (!message) return
      state.unattendedRounds++
      output.message = message
    },
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
