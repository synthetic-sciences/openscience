import os from "node:os"

// Machine-level capacity for the Compute strip. Knows nothing about kernels,
// sessions or projects, so it can be sampled and tested on its own.
export namespace KernelHost {
  export interface Times {
    active: number
    total: number
  }

  export interface Mark {
    times: Times
    at: number
  }

  // os.freemem() reports MemFree on Linux, which excludes reclaimable page
  // cache — a healthy 16 GB desktop reads as ~1.4 GB free. MemAvailable is the
  // kernel's own estimate of what a new workload could claim without swapping.
  export function available(meminfo: string) {
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m)
    if (!match) return
    const value = Number.parseInt(match[1] ?? "", 10)
    if (!Number.isFinite(value)) return
    return value * 1024
  }

  export function times(cpus: os.CpuInfo[]): Times {
    return cpus.reduce(
      (sum, cpu) => {
        const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
        return { active: sum.active + (total - cpu.times.idle), total: sum.total + total }
      },
      { active: 0, total: 0 },
    )
  }

  export function busy(prev: Times, next: Times, cores: number) {
    const total = next.total - prev.total
    const active = next.active - prev.active
    if (total <= 0 || active < 0) return
    return Math.min(cores, (active / total) * cores)
  }

  // The baseline advances only when the window produced a reading; a failed
  // window keeps the older mark so the next call measures across a span that
  // has actually advanced. Pure, so the rule is testable without wall clock.
  //
  // A window under a second is refused outright, the same floor
  // KernelMetrics.derive applies and for the same reason: os.cpus() counts in
  // 10ms jiffies, so two requests arriving milliseconds apart measure a span in
  // which at most one core has ticked once. That single jiffy landing on idle
  // reads as `busy: 0` on a machine running at three cores, and landing on
  // user/sys reads as every core pegged — 12 of 120 concurrent polls came back
  // one or the other. Too short to measure is not a measurement, and the
  // retention rule above already has the right answer for it: keep the older
  // baseline so the NEXT call spans something real, and report nothing now.
  export function advance(previous: Mark, fresh: Mark, cores: number) {
    const elapsed = fresh.at - previous.at
    const value = elapsed >= 1_000 ? busy(previous.times, fresh.times, cores) : undefined
    if (value === undefined) return { baseline: previous, reading: {} }
    return { baseline: fresh, reading: { busy: value } }
  }

  const mark = (): Mark => ({ times: times(os.cpus()), at: Date.now() })

  // Rolling baseline: a 2.5s poll compares against the previous poll and pays
  // nothing. A cold call, or one whose baseline is too old to average
  // meaningfully, takes a single 200ms sample instead.
  let baseline: ReturnType<typeof mark> | undefined

  // Drops the rolling baseline so the next snapshot takes the cold 200ms
  // sample. Without it a caller inherits whatever window an earlier caller in
  // the same process left behind, and a window that has not advanced yields no
  // busy figure at all — an outcome that depends on call order, not on code.
  export function reset() {
    baseline = undefined
  }

  const load = async (cores: number) => {
    const previous = baseline
    const fresh = mark()
    if (previous && fresh.at - previous.at <= 30_000) {
      const result = advance(previous, fresh, cores)
      baseline = result.baseline
      return result.reading
    }
    // The cold sample keeps its own 200ms window rather than the 1s floor
    // above: it takes BOTH marks itself, so there is no shared baseline another
    // request can truncate, and 200ms is ~20 jiffies per core — resolution
    // enough for a real reading. Blocking the first paint for a full second to
    // gain precision nobody asked for is the worse trade.
    await Bun.sleep(200)
    const next = mark()
    baseline = next
    const value = busy(fresh.times, next.times, cores)
    return value === undefined ? {} : { busy: value }
  }

  export async function snapshot() {
    const meminfo = await Bun.file("/proc/meminfo")
      .text()
      .catch(() => "")
    const total = os.totalmem()
    const free = available(meminfo) ?? os.freemem()
    const cores = os.cpus().length
    return {
      memory: { total, available: Math.min(total, free) },
      cpu: { cores, ...(await load(cores)) },
    }
  }
}
