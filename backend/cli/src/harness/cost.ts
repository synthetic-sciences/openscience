import type { Hooks, Plugin } from "@synsci/plugin"
import { Config } from "@/config/config"
import { Session } from "@/session"
import { HarnessState } from "./state"

/**
 * Spend beside the time budget: every finished step's cost and tokens are
 * accumulated per session and rendered as a per-step status line at the tail
 * of the context (a spend figure changes every step, so it must stay out of
 * the cached system prompt). An optional soft ceiling (harness.cost.max_usd)
 * adds a wrap-up reminder once, never a hard stop.
 */
export namespace Cost {
  /** What the figure covers, said once so the model does not read a lead's
   * spend as the whole study's: this session's own model calls. */
  export function line(spend: HarnessState.Session["spend"]) {
    const dollars = spend.cost >= 0.01 ? `$${spend.cost.toFixed(2)}` : `$${spend.cost.toFixed(4)}`
    return `Spent so far on this session's model calls: ${dollars} (${spend.tokens.toLocaleString()} tokens); workers and compute jobs are counted separately.`
  }

  /** The in-memory count starts at zero whenever the process does; the
   * transcript remembers every finished step. Sum it once per session so a
   * restart mid-session never shows a 40-step conversation as free. */
  export async function seed(sessionID: string) {
    const spend = HarnessState.get(sessionID).spend
    if (spend.seeded) return spend
    spend.seeded = true
    const messages = await Session.messages({ sessionID }).catch(() => [])
    let cost = 0
    let tokens = 0
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      cost += message.info.cost ?? 0
      tokens += message.info.tokens.input + message.info.tokens.output + message.info.tokens.reasoning
    }
    spend.cost = Math.max(spend.cost, cost)
    spend.tokens = Math.max(spend.tokens, tokens)
    return spend
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
      await Cost.seed(input.sessionID)
      output.status.push(Cost.line(state.spend))
      const ceiling = HarnessState.costCeiling(await Config.get())
      if (ceiling === undefined || state.spend.cost < ceiling || state.spend.ceilingNoted) return
      state.spend.ceilingNoted = true
      output.status.push(
        `Spend reminder: the soft ceiling of $${ceiling.toFixed(2)} is reached. Wrap up: finish the deliverables in hand and report what remains.`,
      )
    },
  }
  return hooks
}
