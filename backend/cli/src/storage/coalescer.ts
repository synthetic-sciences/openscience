import { Log } from "../util/log"

const log = Log.create({ service: "coalescer" })

export function createCoalescer<T>(
  flush: (key: string, value: T) => Promise<void> | void,
  delayMs: number,
  onError: (key: string, error: unknown) => void = (key, error) => log.error("flush failed", { key, error }),
) {
  const pending = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>()

  const run = async (key: string) => {
    const entry = pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(key)
    await flush(key, entry.value)
  }

  return {
    push(key: string, value: T) {
      const existing = pending.get(key)
      if (existing) {
        existing.value = value
        return
      }
      // A timer-driven flush has no awaiting caller, so its rejection would
      // otherwise be dropped on the floor as an unhandled promise.
      const timer = setTimeout(() => run(key).catch((error) => onError(key, error)), delayMs)
      pending.set(key, { value, timer })
    },
    flushNow: run,
    async flushAll() {
      const keys = [...pending.keys()]
      for (const key of keys) await run(key)
    },
    async flushWhere(predicate: (key: string) => boolean) {
      const keys = [...pending.keys()].filter(predicate)
      for (const key of keys) await run(key)
    },
  }
}
