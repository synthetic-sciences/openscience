import { CommandRuntime } from "@/science/command/registry"
import { Instance } from "@/project/instance"
import { UpdateQuiescence } from "./update-quiescence"

type Dependencies = {
  seal: () => void
  stopCommands: () => Promise<unknown>
  disposeInstances: () => Promise<unknown>
}

type Options = {
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000

/** Build an idempotent shutdown barrier. The underlying cleanup keeps running
 * after a caller's bounded wait expires, so a later signal or desktop retry
 * observes the same disposal instead of launching competing ledger teardown. */
export function createGracefulDisposer(input: Dependencies) {
  let pending: Promise<void> | undefined
  let attempted = false

  const dispose = async (options: Options = {}) => {
    attempted = true
    input.seal()
    if (!pending) {
      const operation = Promise.allSettled([input.stopCommands(), input.disposeInstances()]).then((results) => {
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
        if (failures.length) throw new AggregateError(failures, "OpenScience could not release every active runtime")
      })
      pending = operation
      void operation.catch(() => {
        if (pending === operation) pending = undefined
      })
    }
    const operation = pending

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`OpenScience runtime disposal did not finish within ${timeoutMs}ms`)),
            timeoutMs,
          )
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** The catch-all disposal a process runs on its way out, for the commands
   *  that never disposed anything themselves. A command that already ran the
   *  disposal has made this process's one attempt, and a failed attempt drops
   *  the memo above so a *retry* starts over — right for a desktop handoff
   *  that will ask again, wrong here: nothing is left to retry with, and a
   *  second teardown from scratch would spend a leaving process's last
   *  seconds redoing work that just failed. */
  const final = async (options: Options = {}) => {
    if (attempted) return
    await dispose(options)
  }

  return Object.assign(dispose, { final })
}

const dispose = createGracefulDisposer({
  seal: UpdateQuiescence.seal,
  stopCommands: CommandRuntime.stopAll,
  disposeInstances: () => Instance.disposeAll({ strict: true }),
})

export namespace GracefulShutdown {
  export const run = dispose
  export const final = dispose.final
}
