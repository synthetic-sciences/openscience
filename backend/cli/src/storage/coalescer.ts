export function createCoalescer<T>(flush: (key: string, value: T) => Promise<void> | void, delayMs: number) {
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
      const timer = setTimeout(() => void run(key), delayMs)
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
