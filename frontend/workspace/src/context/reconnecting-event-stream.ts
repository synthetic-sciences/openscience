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

export async function consumeReconnectingStream<T>(options: {
  connect: () => Promise<{ stream: AsyncIterable<T> }>
  onEvent: (event: T) => void | Promise<void>
  signal: AbortSignal
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}) {
  let failures = 0
  while (!options.signal.aborted) {
    const connected = await options
      .connect()
      .then(async (events) => {
        let received = false
        for await (const event of events.stream) {
          if (options.signal.aborted) return received
          received = true
          await options.onEvent(event)
        }
        return received
      })
      .catch(() => false)

    if (options.signal.aborted) return
    failures = connected ? 0 : failures + 1
    await (options.sleep ?? pause)(reconnectDelay(failures), options.signal)
  }
}
