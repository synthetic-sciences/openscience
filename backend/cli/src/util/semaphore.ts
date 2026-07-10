/** Counting semaphore. `acquire()` resolves once a slot is free; `release()`
 *  hands a freed slot directly to the next waiter (FIFO) or returns it to the
 *  pool. Used to bound how many heavy compute subagents run at once (#102). */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    this.available = Math.max(1, Math.floor(max))
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
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
