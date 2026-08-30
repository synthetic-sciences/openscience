export async function withAccountDeadline<T>(request: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  const expired = new Promise<never>((_, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Ace account refresh timed out. Try again."))
      controller.abort()
    }, ms)
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true })
  })
  return Promise.race([Promise.resolve().then(() => request(controller.signal)), expired]).finally(() =>
    controller.abort(),
  )
}
