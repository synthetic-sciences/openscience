/** Counting semaphore. `acquire()` resolves once a slot is free; `release()`
 *  hands a freed slot directly to the next waiter (FIFO) or returns it to the
 *  pool. Used to bound how many heavy compute subagents run at once (#102). */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    this.available = Math.max(1, Math.floor(max))
  }

  /** Resolves once a slot is free. If `signal` aborts while this call is queued,
   *  the waiter is removed and acquire() rejects — so a cancelled caller never
   *  holds a slot and release() never hands one to a dead waiter (#102). */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted while waiting for a slot")
    if (this.available > 0) {
      this.available--
      return
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(signal!.reason ?? new Error("aborted while waiting for a slot"))
      }
      this.waiters.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next() // slot transferred straight to the waiter; count stays "taken"
      return
    }
    this.available++
  }
}
