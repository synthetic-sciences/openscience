/**
 * A subscriber list for "something the whole app derives state from just
 * changed", plus the one ordering rule those subscribers need.
 *
 * `notifyAfter` runs the work first and notifies afterwards, so a listener that
 * re-reads server state never races the write it is reacting to. It notifies on
 * failure too, and re-throws: the caller still sees the error (its own UI
 * reports it), but a listener whose state genuinely did change server-side is
 * not left stale by an unrelated failure elsewhere in the same batch.
 *
 * Listeners are copied before iteration so one that unsubscribes itself — or
 * subscribes another — cannot mutate the set mid-notify.
 */
export function createListeners() {
  const listeners = new Set<() => void>()

  return {
    /** Subscribe. Returns the unsubscribe, shaped for Solid's `onCleanup`. */
    add(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async notifyAfter(body: () => Promise<void>) {
      try {
        await body()
      } finally {
        for (const listener of [...listeners]) listener()
      }
    },
  }
}
