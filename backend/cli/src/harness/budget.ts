import os from "node:os"
import path from "path"
import type { Hooks, Plugin } from "@synsci/plugin"
import { Session } from "@/session"
import { SessionLoopState } from "@/session/loop-state"
import type { MessageV2 } from "@/session/message-v2"
import { HarnessState } from "./state"

/**
 * The machine and the clock, stated in <env> so the model plans against
 * facts: CPUs and memory from the cgroup (the limits a container actually
 * enforces) with host fallbacks, and the time budget with elapsed time when a
 * deadline was set. Reminders appear once at 50% and 85% of the budget, and a
 * final answer with deliverables unchecked and more than 15% of the budget
 * left is asked to continue.
 */
export namespace Budget {
  async function read(file: string) {
    return Bun.file(file)
      .text()
      .then((text) => text.trim())
      .catch(() => undefined)
  }

  /** CPU count and memory (GiB) the process may use. */
  export async function compute(root = HarnessState.cgroup.root) {
    const cpuMax = await read(path.join(root, "cpu.max"))
    const memoryMax = await read(path.join(root, "memory.max"))
    const cpus = (() => {
      const [quota, period] = (cpuMax ?? "").split(/\s+/)
      const q = Number(quota)
      const p = Number(period)
      if (quota && quota !== "max" && Number.isFinite(q) && Number.isFinite(p) && p > 0)
        return Math.max(1, Math.round(q / p))
      return os.availableParallelism()
    })()
    const bytes = (() => {
      const value = Number(memoryMax)
      if (memoryMax && memoryMax !== "max" && Number.isFinite(value) && value > 0) return value
      return os.totalmem()
    })()
    return { cpus, gib: Math.round((bytes / 1024 ** 3) * 10) / 10 }
  }

  export function duration(ms: number) {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m` : `${hours}h`
  }

  /** The stable `<env>` line: what the machine offers. It never changes
   * during a session, so it can live in the cached system prompt. */
  /** The facts that hold for the whole session and so may sit in the cached
   * system prompt: the machine, and the time budget's total when there is
   * one (its deadline is fixed when the turn that set it begins). */
  export function lines(machine: { cpus: number; gib: number }, state?: HarnessState.Session) {
    // What a budget means to someone working alone: the work ends when the
    // turn ends, and time left over is not kept for later. Without this, a
    // lead whose own checks still fail writes a hand-off ("the target is not
    // yet verified") as if someone would pick it up, and stops with most of
    // the budget unused.
    const budget =
      state?.deadline && state.startedAt
        ? [
            `Time budget: ${duration(state.deadline - state.startedAt)}. The work ends when you end your turn and unused time is not kept: while your own checks show the result falls short of what was asked and time remains, keep improving it; end the turn when it meets its checks or the remaining time cannot change it.`,
          ]
        : []
    return [`Compute: ${machine.cpus} CPUs, ${machine.gib} GiB`, ...budget]
  }

  /** The one-shot reminders, each carrying the figures it is about. There is
   * no standing "elapsed" line: a value that changes every step would be
   * appended to the transcript every step. */
  export function status(state: HarnessState.Session, now: number) {
    if (!state.deadline || !state.startedAt) return []
    const total = state.deadline - state.startedAt
    const elapsed = Math.max(0, now - state.startedAt)
    const fraction = total > 0 ? elapsed / total : 1
    const used = `${duration(elapsed)} of the ${duration(total)} time budget is used`
    if (fraction >= 0.85 && !state.budgetReminders.has(85)) {
      state.budgetReminders.add(85)
      return [`Time reminder: ${used} (85%). Finish the deliverables you can and write real partial results.`]
    }
    if (fraction >= 0.5 && fraction < 0.85 && !state.budgetReminders.has(50) && !state.budgetReminders.has(85)) {
      state.budgetReminders.add(50)
      return [`Time reminder: ${used} (half). Prioritize the remaining deliverables.`]
    }
    return []
  }

  export function remaining(state: HarnessState.Session, now: number) {
    if (!state.deadline || !state.startedAt) return
    const total = state.deadline - state.startedAt
    return total > 0 ? (state.deadline - now) / total : 0
  }
}

export const BudgetUnit: Plugin = async () => {
  const hooks: Hooks = {
    async "chat.message"(input, output) {
      const state = HarnessState.get(input.sessionID)
      const message = output.message as MessageV2.User
      if (
        !message.deadline ||
        !SessionLoopState.external({ info: message, parts: output.parts } as MessageV2.WithParts)
      )
        return
      state.startedAt = message.time.created
      state.deadline = message.deadline
      state.budgetReminders.clear()
      state.budgetNudged = false
    },
    async "env.lines"(input, output) {
      const state = HarnessState.get(input.sessionID)
      output.lines.push(...Budget.lines(await Budget.compute(), state))
      output.status.push(...Budget.status(state, HarnessState.clock.now()))
    },
    async "loop.before_finish"(input, output) {
      const state = HarnessState.get(input.sessionID)
      if (output.message) return
      // A worker's brief is not the user's request; the lead answers for it.
      const session = await Session.get(input.sessionID).catch(() => undefined)
      if (session?.parentID) return
      if (state.budgetNudged || !state.deliverablesFailing) return
      const left = Budget.remaining(state, HarnessState.clock.now())
      if (left === undefined || left <= 0.15) return
      state.budgetNudged = true
      output.message =
        "Time remains in the budget and deliverables are still unchecked; continue, or write the best real version of the missing outputs and say what is partial."
    },
    async event({ event }) {
      if (event.type === "session.deleted") HarnessState.clear(event.properties.info.id)
    },
  }
  return hooks
}
