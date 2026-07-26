export function createSearchCache<T>(input: {
  scan: () => Promise<T>
  empty: () => T
  maxAgeMs: number
  now?: () => number
}) {
  const now = input.now ?? Date.now
  let value: T | undefined
  let pending: Promise<T> | undefined
  let refreshedAt = 0
  let invalidation = 0

  const refresh = () => {
    if (pending) return pending
    const generation = invalidation
    pending = input
      .scan()
      .then((next) => {
        value = next
        refreshedAt = now()
        return next
      })
      .finally(() => {
        pending = undefined
      })
    pending.then(
      () => {
        if (invalidation === generation) invalidation = 0
      },
      () => {},
    )
    return pending
  }

  const read = async () => {
    if (value === undefined) return refresh().catch(input.empty)

    const expired = now() - refreshedAt >= input.maxAgeMs
    if (invalidation > 0 || expired) void refresh().catch(() => {})
    return value
  }

  return {
    read,
    prime: () => void refresh().catch(() => {}),
    invalidate: () => {
      invalidation++
    },
  }
}
