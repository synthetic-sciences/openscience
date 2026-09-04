/**
 * How long an account surface waits for the local server's answer.
 *
 * The server owns the one deadline on account reads (15 s, propagated to its
 * outbound fetches), so it always answers within that budget with either
 * current values or a bounded failure. This wait only covers a dead
 * transport, which is why it sits above the server's deadline: the UI must
 * never give up before the server's answer arrives. Aborting the request
 * aborts the route's signal, which cancels the outbound reads.
 */
export const ACCOUNT_DEADLINE_MS = 20_000

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
