/**
 * Share an in-flight load between concurrent callers, keyed by scope.
 *
 * The bootstrap burst asks for the same catalog from several places within a
 * few milliseconds; this collapses those into one request. What it must never
 * do is outlive the request itself — an entry that is only removed when the
 * promise settles becomes permanent the moment a request hangs (a severed
 * connection, a server restart mid-flight), and from then on every caller gets
 * handed the dead promise instead of a new request. `timeoutMs` bounds that:
 * the entry always leaves the map, settled or not.
 */
export function createInflightCache<T>(
  load: (key: string) => Promise<T>,
  options: { holdMs?: number; timeoutMs?: number } = {},
) {
  const hold = options.holdMs ?? 1_000
  const timeout = options.timeoutMs ?? 30_000
  const entries = new Map<string, Promise<T>>()

  const drop = (key: string, promise: Promise<T>) => {
    if (entries.get(key) === promise) entries.delete(key)
  }

  return {
    get(key: string) {
      const pending = entries.get(key)
      if (pending) return pending

      const promise = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`load timed out after ${timeout}ms`)), timeout)
        load(key).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })

      entries.set(key, promise)
      promise.then(
        // Hold a resolved value briefly so the bootstrap burst shares it, then
        // let it expire — a stale catalog is worse than a second request.
        () => setTimeout(() => drop(key, promise), hold),
        () => drop(key, promise),
      )
      return promise
    },
    invalidate(key?: string) {
      if (key === undefined) {
        entries.clear()
        return
      }
      entries.delete(key)
    },
  }
}
