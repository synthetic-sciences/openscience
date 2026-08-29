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

  return async (options: Options = {}) => {
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
}

const dispose = createGracefulDisposer({
  seal: UpdateQuiescence.seal,
  stopCommands: CommandRuntime.stopAll,
  disposeInstances: () => Instance.disposeAll({ strict: true }),
})

export namespace GracefulShutdown {
  export const run = dispose
}
