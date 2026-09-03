export function reconnectDelay(failures: number) {
  return Math.min(250 * 2 ** Math.max(0, failures - 1), 5000)
}

function pause(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

const STABLE_MS = 5_000

export async function consumeReconnectingStream<T>(options: {
  connect: () => Promise<{ stream: AsyncIterable<T> }>
  onEvent: (event: T) => void | Promise<void>
  signal: AbortSignal
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  stable?: number
}) {
  const now = options.now ?? Date.now
  const stable = options.stable ?? STABLE_MS
  let failures = 0
  while (!options.signal.aborted) {
    const connected = await options
      .connect()
      .then(async (events) => {
        const opened = now()
        let received = false
        for await (const event of events.stream) {
          if (options.signal.aborted) return received
          received = true
          // One bad event must not tear down the connection and force a
          // reconnect storm; log it and keep consuming.
          try {
            await options.onEvent(event)
          } catch (error) {
            console.warn("Event handler failed; continuing with the stream", error)
          }
        }
        // A stream that closes right after its first event is not healthy.
        // Only a connection that also stayed open for a while resets backoff.
        return received && now() - opened >= stable
      })
      .catch(() => false)

    if (options.signal.aborted) return
    failures = connected ? 0 : failures + 1
    await (options.sleep ?? pause)(reconnectDelay(failures), options.signal)
  }
}
