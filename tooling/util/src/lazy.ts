export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  const result = (): T => {
    if (loaded) return value as T
    // An initializer may call its own getter; preserve that reentrant guard.
    // If setup throws, clear the guard so a later call can retry.
    loaded = true
    try {
      value = fn()
      return value as T
    } catch (error) {
      loaded = false
      throw error
    }
  }

  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
