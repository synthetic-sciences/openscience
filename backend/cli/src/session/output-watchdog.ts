/** Count only time spent awaiting model events, not local persistence, tool
 * execution, or permission dialogs. Metadata events do not renew this budget. */
export function outputWatchdog(input: {
  timeout: number | false
  signal: AbortSignal
  expire: () => Error
  onTimeout: (error: Error) => void
}) {
  let remaining = input.timeout || 0
  let started = false
  let paused = false
  let waiting = false
  let stamp: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let failure: Error | undefined
  let reject: ((reason: unknown) => void) | undefined

  function clear() {
    clearTimeout(timer)
    timer = undefined
    if (stamp === undefined) return
    remaining -= performance.now() - stamp
    stamp = undefined
  }

  function arm() {
    if (!input.timeout || !started || paused || !waiting || failure || input.signal.aborted) return
    stamp = performance.now()
    timer = setTimeout(
      () => {
        clear()
        failure = input.expire()
        reject?.(failure)
        input.onTimeout(failure)
      },
      Math.max(0, remaining),
    )
  }

  return {
    start() {
      if (started) return
      started = true
      arm()
    },
    progress() {
      clear()
      remaining = input.timeout || 0
      arm()
    },
    pause(value: boolean) {
      if (paused === value) return
      clear()
      paused = value
      arm()
    },
    async next<T>(run: () => Promise<T>): Promise<T> {
      input.signal.throwIfAborted()
      if (failure) throw failure
      const pending = Promise.withResolvers<never>()
      reject = pending.reject
      const abort = () => pending.reject(input.signal.reason)
      input.signal.addEventListener("abort", abort, { once: true })
      waiting = true
      arm()
      try {
        return await Promise.race([run(), pending.promise])
      } finally {
        clear()
        waiting = false
        reject = undefined
        input.signal.removeEventListener("abort", abort)
      }
    },
    dispose() {
      clear()
      started = false
    },
  }
}

export async function* watchOutput<T>(watchdog: ReturnType<typeof outputWatchdog>, iterable: AsyncIterable<T>) {
  const iterator = iterable[Symbol.asyncIterator]()
  let completed = false
  try {
    while (true) {
      const next = await watchdog.next(() => iterator.next())
      if (next.done) {
        completed = true
        return
      }
      yield next.value
    }
  } finally {
    // A broken source may ignore cancellation and still have next() pending.
    // Request cleanup, but do not let its return() hang timeout finalization.
    if (!completed) void iterator.return?.().catch(() => {})
  }
}
