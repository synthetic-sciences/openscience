import { Log } from "../util/log"

const log = Log.create({ service: "coalescer" })

export function createCoalescer<T>(
  flush: (key: string, value: T) => Promise<void> | void,
  delayMs: number,
  onError: (key: string, error: unknown) => void = (key, error) => log.error("flush failed", { key, error }),
) {
  const pending = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>()
  const active = new Map<string, Promise<void>>()

  const run = (key: string): Promise<void> => {
    const entry = pending.get(key)
    const previous = active.get(key)
    if (!entry) return previous ?? Promise.resolve()
    clearTimeout(entry.timer)
    pending.delete(key)
    // A timer can already be writing this key when a final value arrives.
    // Serialize those writes so an older value cannot overwrite the final one.
    // A failed older write must not prevent a newer value from being persisted.
    const write = (previous ?? Promise.resolve()).catch(() => undefined).then(() => flush(key, entry.value))
    active.set(key, write)
    const clear = () => {
      if (active.get(key) === write) active.delete(key)
    }
    void write.then(clear, clear)
    return write
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
      const keys = new Set([...pending.keys(), ...active.keys()])
      await Promise.all([...keys].map(run))
    },
    async flushWhere(predicate: (key: string) => boolean) {
      const keys = new Set([...pending.keys(), ...active.keys()])
      await Promise.all([...keys].filter(predicate).map(run))
    },
  }
}
