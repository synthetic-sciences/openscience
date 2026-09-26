import type { Hooks, Plugin } from "@synsci/plugin"
import { HarnessState } from "./state"

export const REDIRECT_MESSAGE =
  "The same failure has occurred three times. Diagnose the root cause, then change tool, library or method, or split the step; do not retry as-is."

export function repeatedCallMessage(tool: string | undefined) {
  return `The same incomplete ${tool ?? "tool"} call was sent twice and was not executed either time. Send it once with every required argument complete, or do the work another way; do not resend it as-is.`
}

/**
 * A tripped repetition guard becomes one strategy-change message instead of a
 * dead stop. The second trip in a session stops the loop as it always did:
 * one redirect is a nudge, two would be the loop again.
 */
export const RedirectUnit: Plugin = async () => {
  const hooks: Hooks = {
    async "loop.guard"(input, output) {
      const state = HarnessState.get(input.sessionID)
      state.guardTrips++
      if (state.guardTrips > 1) return
      output.message = input.kind === "repeated_call" ? repeatedCallMessage(input.tool) : REDIRECT_MESSAGE
    },
    async event({ event }) {
      if (event.type === "session.idle") HarnessState.get(event.properties.sessionID).guardTrips = 0
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
