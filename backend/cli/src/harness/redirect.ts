import type { Hooks, Plugin } from "@synsci/plugin"
import { HarnessState } from "./state"

export const REDIRECT_MESSAGE =
  "The same failure has occurred three times. Diagnose the root cause, then change tool, library or method, or split the step; do not retry as-is."

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
      output.message = REDIRECT_MESSAGE
    },
    async event({ event }) {
      if (event.type === "session.idle") HarnessState.get(event.properties.sessionID).guardTrips = 0
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
