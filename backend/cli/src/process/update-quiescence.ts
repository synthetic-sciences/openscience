/** Process-local admission gate held only after a verified desktop update has
 * passed the final active-work check. Existing work is never cancelled; new
 * agent turns and compute starts fail visibly while Electron exits. */
export namespace UpdateQuiescence {
  export type Activity = "admission" | "pty" | "kernel" | "mcp"

  let draining = false
  let sealed = false
  let admissions = 0
  const activity = new Map<Activity, number>()

  /** Hold while a compute start is preparing. The desktop updater may only
   * begin draining after every admitted start has either failed or become
   * visible through the normal active-work counters. */
  export function enter(kind: Activity = "admission") {
    assertOpen()
    admissions++
    activity.set(kind, (activity.get(kind) ?? 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      admissions--
      const count = (activity.get(kind) ?? 1) - 1
      if (count > 0) activity.set(kind, count)
      else activity.delete(kind)
    }
  }

  export function begin() {
    if (draining) throw new Error("OpenScience is already restarting to install an update")
    if (admissions) {
      throw new Error("OpenScience is starting new work. Try the update again in a moment.")
    }
    draining = true
    let active = true
    return () => {
      if (!active) return
      active = false
      if (!sealed) draining = false
    }
  }

  /** Irreversibly close admission for process shutdown. Unlike begin(), this
   * is intentionally idempotent and does not require active work to have
   * settled: the graceful disposer owns cancelling and reaping that work. */
  export function seal() {
    sealed = true
    draining = true
  }

  export function assertOpen() {
    if (draining) throw new Error("OpenScience is restarting to install a verified update. Retry after it reopens.")
  }

  export function pending() {
    return draining
  }

  export function admitted() {
    return admissions
  }

  /** Exact process-local work that has crossed the update admission boundary.
   * Long-lived runtimes hold their category until they are safe to interrupt;
   * short spawn handoffs use the generic admission category. */
  export function active(kind: Activity) {
    return activity.get(kind) ?? 0
  }

  export function inventory() {
    return {
      admitted: admissions,
      pty: active("pty"),
      kernel: active("kernel"),
      mcp: active("mcp"),
    }
  }
}
