import os from "node:os"

// Machine-level capacity for the Compute strip. Knows nothing about kernels,
// sessions or projects, so it can be sampled and tested on its own.
export namespace KernelHost {
  export interface Times {
    active: number
    total: number
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

  const mark = () => ({ times: times(os.cpus()), at: Date.now() })

  // Rolling baseline: a 2.5s poll compares against the previous poll and pays
  // nothing. A cold call, or one whose baseline is too old to average
  // meaningfully, takes a single 200ms sample instead.
  let baseline: ReturnType<typeof mark> | undefined

  const load = async (cores: number) => {
    const previous = baseline
    const fresh = mark()
    if (previous && fresh.at - previous.at <= 30_000) {
      const value = busy(previous.times, fresh.times, cores)
      // Advance the baseline ONLY when the window produced a reading. Two
      // calls inside one ~10ms scheduler tick read identical os.cpus() times;
      // overwriting the baseline there would reset the window every poll and
      // starve the measurement forever. Keeping the older mark lets the next
      // call measure across a span that has actually advanced.
      if (value === undefined) return {}
      baseline = fresh
      return { busy: value }
    }
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
