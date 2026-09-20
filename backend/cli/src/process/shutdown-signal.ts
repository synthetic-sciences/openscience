const SIGNALS = ["SIGINT", "SIGTERM"] as const
type Signal = (typeof SIGNALS)[number]

const owners = new Map<Signal, () => void>()

/** One owner for this process's termination signals.
 *
 * Modules that spawn kernels install their own SIGINT/SIGTERM hooks when they
 * are imported, because a kernel child must never outlive the process that
 * spawned it, and those hooks end the process on the spot. A long-lived server
 * needs the opposite: the signal has to reach its own shutdown body so the
 * runtimes are released and the advertisement withdrawn before the process
 * goes away. The server claims the signal here; the import-time hooks ask
 * `owned` first and defer, so a claimed signal starts exactly one shutdown and
 * the process still exits through the owner's own path. */
export namespace ShutdownSignal {
  /** Whether an owner is still waiting for the first delivery of `signal`. */
  export function owned(signal: Signal) {
    return owners.has(signal)
  }

  /** Own SIGINT and SIGTERM until the first of them is delivered, and return
   * the release the owner runs when it stops listening for another reason.
   * Ownership ends with that first delivery rather than with the shutdown it
   * starts: a second signal comes from a caller who has waited long enough,
   * and it falls through to the immediate exit an unclaimed signal always
   * had. */
  export function claim(handler: () => void) {
    const installed: { signal: Signal; listener: () => void }[] = []
    const release = () => {
      for (const entry of installed) {
        if (owners.get(entry.signal) === handler) owners.delete(entry.signal)
        process.off(entry.signal, entry.listener)
      }
      installed.length = 0
    }
    for (const signal of SIGNALS) {
      const listener = () => {
        // Release after this delivery rather than during it. Every hook
        // listening for the same signal has to see it owned, whichever order
        // they were installed in; the hooks that run after this one would
        // otherwise find the signal free and end the process.
        queueMicrotask(release)
        handler()
      }
      owners.set(signal, handler)
      installed.push({ signal, listener })
      process.on(signal, listener)
    }
    return release
  }
}
