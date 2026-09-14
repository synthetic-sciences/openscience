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
  const dollars = (value: number) => (value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`)

  /** What the figure covers, said once: this session's own model calls and,
   * separately, the workers it delegated to. A lead that delegates spends
   * most of a study's money in its workers; a figure that left them out read
   * as the whole and let a ceiling pass unnoticed. */
  export function line(spend: HarnessState.Session["spend"]) {
    return `Spent so far: ${dollars(spend.cost)} on this session's model calls (${spend.tokens.toLocaleString()} tokens) and ${dollars(spend.workers)} on its workers; compute jobs are counted separately.`
  }

  /** How deep worker spend is attributed: a worker's workers still bill the
   * lead that started the chain. */
  const ANCESTRY = 4

  /** The lead a step bills: the session's own state, or its ancestor lead's
   * worker figure when the session is a child. */
  export async function attribute(sessionID: string, cost: number) {
    const own = HarnessState.get(sessionID).spend
    let current = sessionID
    for (let depth = 0; depth < ANCESTRY; depth++) {
      const info = await Session.get(current).catch(() => undefined)
      if (!info?.parentID) return own
      HarnessState.get(info.parentID).spend.workers += cost
      current = info.parentID
    }
    return own
  }

  /** The in-memory count starts at zero whenever the process does; the
   * transcript remembers every finished step. Sum it once per session so a
   * restart mid-session never shows a 40-step conversation as free. */
  export async function seed(sessionID: string) {
    const spend = HarnessState.get(sessionID).spend
    if (spend.seeded) return spend
    spend.seeded = true
    const own = await total(sessionID)
    spend.cost = Math.max(spend.cost, own.cost)
    spend.tokens = Math.max(spend.tokens, own.tokens)
    spend.workers = Math.max(spend.workers, await workers(sessionID))
    return spend
  }

  async function total(sessionID: string) {
    const messages = await Session.messages({ sessionID }).catch(() => [])
    let cost = 0
    let tokens = 0
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      cost += message.info.cost ?? 0
      tokens += message.info.tokens.input + message.info.tokens.output + message.info.tokens.reasoning
    }
    return { cost, tokens }
  }

  /** Every descendant worker's recorded spend, from the transcripts. */
  export async function workers(sessionID: string, depth = ANCESTRY): Promise<number> {
    if (depth <= 0) return 0
    const children = await Session.children(sessionID).catch(() => [])
    let sum = 0
    for (const child of children) {
      sum += (await total(child.id)).cost
      sum += await workers(child.id, depth - 1)
    }
    return sum
  }
}

export const CostUnit: Plugin = async () => {
  const hooks: Hooks = {
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
      if (event.type !== "message.part.updated") return
      const part = event.properties.part
      if (part.type !== "step-finish") return
      const spend = await Cost.attribute(part.sessionID, part.cost)
      spend.cost += part.cost
      spend.tokens += part.tokens.input + part.tokens.output + part.tokens.reasoning
    },
    async "env.lines"(input, output) {
      const state = HarnessState.get(input.sessionID)
      await Cost.seed(input.sessionID)
      output.status.push(Cost.line(state.spend))
      const ceiling = HarnessState.costCeiling(await Config.get())
      if (ceiling === undefined || state.spend.cost + state.spend.workers < ceiling || state.spend.ceilingNoted) return
      state.spend.ceilingNoted = true
      output.status.push(
        `Spend reminder: the soft ceiling of $${ceiling.toFixed(2)} is reached. Wrap up: finish the deliverables in hand and report what remains.`,
      )
    },
  }
  return hooks
}
