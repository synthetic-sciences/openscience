import os from "node:os"
import path from "path"
import type { Hooks, Plugin } from "@synsci/plugin"
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

  export function lines(state: HarnessState.Session, now: number, machine: { cpus: number; gib: number }) {
    const out = [`Compute: ${machine.cpus} CPUs, ${machine.gib} GiB`]
    if (!state.deadline || !state.startedAt) return out
    const total = state.deadline - state.startedAt
    const elapsed = Math.max(0, now - state.startedAt)
    out.push(`Time budget: ${duration(total)}, elapsed ${duration(elapsed)}`)
    const fraction = total > 0 ? elapsed / total : 1
    if (fraction >= 0.85 && !state.budgetReminders.has(85)) {
      state.budgetReminders.add(85)
      out.push(
        "Time reminder: 85% of the budget is used. Finish the deliverables you can and write real partial results.",
      )
    } else if (fraction >= 0.5 && !state.budgetReminders.has(50)) {
      state.budgetReminders.add(50)
      out.push("Time reminder: half the budget is used. Prioritize the remaining deliverables.")
    }
    return out
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
      const message = output.message as { deadline?: number; internal?: unknown; time?: { created: number } }
      if (message.internal && (message.internal as { type?: string }).type !== "prompt") return
      state.startedAt ??= message.time?.created ?? HarnessState.clock.now()
      if (message.deadline) state.deadline = message.deadline
    },
    async "env.lines"(input, output) {
      const state = HarnessState.get(input.sessionID)
      output.lines.push(...Budget.lines(state, HarnessState.clock.now(), await Budget.compute()))
    },
    async "loop.before_finish"(input, output) {
      const state = HarnessState.get(input.sessionID)
      if (output.message || state.budgetNudged || !state.deliverablesFailing) return
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
