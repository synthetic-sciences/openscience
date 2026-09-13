import type { Hooks, Plugin } from "@synsci/plugin"
import { Config } from "@/config/config"
import { HarnessState } from "./state"

/**
 * Spend beside the time budget: every finished step's cost and tokens are
 * accumulated per session and rendered in <env>. An optional soft ceiling
 * (harness.cost.max_usd) adds a wrap-up reminder once, never a hard stop.
 */
export namespace Cost {
  export function line(spend: HarnessState.Session["spend"]) {
    const dollars = spend.cost >= 0.01 ? `$${spend.cost.toFixed(2)}` : `$${spend.cost.toFixed(4)}`
    return `Spent so far: ${dollars} (${spend.tokens.toLocaleString()} tokens)`
  }
}

export const CostUnit: Plugin = async () => {
  const hooks: Hooks = {
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
      if (event.type !== "message.part.updated") return
      const part = event.properties.part
      if (part.type !== "step-finish") return
      const spend = HarnessState.get(part.sessionID).spend
      spend.cost += part.cost
      spend.tokens += part.tokens.input + part.tokens.output + part.tokens.reasoning
    },
    async "env.lines"(input, output) {
      const state = HarnessState.get(input.sessionID)
      output.lines.push(Cost.line(state.spend))
      const ceiling = HarnessState.costCeiling(await Config.get())
      if (ceiling === undefined || state.spend.cost < ceiling || state.spend.ceilingNoted) return
      state.spend.ceilingNoted = true
      output.lines.push(
        `Spend reminder: the soft ceiling of $${ceiling.toFixed(2)} is reached. Wrap up: finish the deliverables in hand and report what remains.`,
      )
    },
  }
  return hooks
}
