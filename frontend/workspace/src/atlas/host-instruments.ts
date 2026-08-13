export type Capacity = {
  memory: { total: number; available: number; compute?: number; kernels?: number }
  cpu: { cores: number; busy?: number; compute?: number; kernels?: number }
  kernels: { live: number; running: number }
  commands?: { live: number; running: number }
  jobs?: { live: number; running: number }
}

export type Reading = {
  headline: string
  memory: string
  memoryFill: number
  cores: string
  cpuFill: number
  live: string
  running: string
  kernels: string
}

const ratio = (value: number, of: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(of) || of <= 0) return 0
  return Math.min(1, Math.max(0, value / of))
}

const gb = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return (value / 1_000_000_000).toFixed(1)
}

const bytes = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
  if (value < 1_000) return `${Math.round(value)} B`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`
  return `${(value / 1_000_000_000).toFixed(1)} GB`
}

/** How many bars the histogram draws. At the 2.5s poll it spans about a
 *  minute, which is the window in which a run's memory actually moves. */
export const SAMPLES = 20

/**
 * The instrument block 3a puts above the tabs.
 *
 * Takes a PARTIAL capacity for the same reason the earlier model did: the route
 * omits any figure it could not measure, and a version skew or a half-written
 * response can drop a whole section. Each reading is guarded on its own
 * section, so a body missing one degrades only that figure — dereferencing an
 * absent section would throw inside a memo, and the nearest ErrorBoundary wraps
 * the entire workspace.
 *
 * Pure, so it can be asserted without mounting or a live server.
 */
export function hostReading(capacity?: Partial<Capacity>): Reading {
  const memory = capacity?.memory
  const cpu = capacity?.cpu
  const total = gb(memory?.total)
  // This pane accounts for compute, not every process on the user's machine.
  // Kernel RSS and CPU are the figures a user can affect by stopping work here.
  const used = memory?.compute ?? memory?.kernels
  const cores = cpu?.cores
  const kernels = capacity?.kernels?.live
  const commands = capacity?.commands?.live
  const jobs = capacity?.jobs?.live
  const live = kernels === undefined ? undefined : kernels + (commands ?? 0) + (jobs ?? 0)
  const running =
    capacity?.kernels?.running === undefined
      ? undefined
      : capacity.kernels.running + (capacity.commands?.running ?? 0) + (capacity.jobs?.running ?? 0)
  const load = cpu?.compute ?? cpu?.kernels ?? 0

  return {
    headline: bytes(used),
    memory: total ? `of ${total} GB memory` : "memory unavailable",
    memoryFill: memory?.total === undefined ? 0 : ratio(used ?? 0, memory.total),
    cores: cores === undefined ? "—" : `~${Number(load.toFixed(1))} of ${cores}`,
    cpuFill: cores === undefined ? 0 : ratio(load, cores),
    live: live === undefined ? "—" : String(live),
    running: running === undefined ? "—" : String(running),
    kernels:
      live === undefined
        ? "kernel count unavailable"
        : commands === undefined
          ? `${live === 1 ? "kernel" : "kernels"} · ${running ?? 0} running`
          : jobs === undefined
            ? `${kernels} ${kernels === 1 ? "kernel" : "kernels"} · ${commands} ${commands === 1 ? "command" : "commands"} · ${running ?? 0} running`
            : `${kernels} ${kernels === 1 ? "kernel" : "kernels"} · ${commands} ${commands === 1 ? "command" : "commands"} · ${jobs} ${jobs === 1 ? "job" : "jobs"} · ${running ?? 0} running`,
  }
}

/**
 * Appends a sample to a bounded history, oldest first.
 *
 * Returns a new array rather than mutating, so a caller holding the previous
 * one — a memo, a rendered frame — keeps seeing what it was given. Values are
 * the fraction of memory in use, which is what the bar heights encode.
 *
 * A poll that failed contributes nothing at all: repeating the last reading
 * would draw a flat stretch that looks like measured calm, and inserting a
 * zero would draw a cliff that never happened.
 */
export function sample(history: readonly number[], capacity?: Partial<Capacity>): number[] {
  const memory = capacity?.memory
  if (!memory) return [...history]
  const used = Math.max(0, memory.total - memory.available)
  return [...history, ratio(used, memory.total)].slice(-SAMPLES)
}

/**
 * Bar heights in px for the histogram, oldest first.
 *
 * Short of a full window the bars are right-aligned against an empty left,
 * so a freshly opened panel reads as "not measured yet" rather than as a
 * sudden climb from nothing. `recent` marks the newest few, which 3a draws in
 * the accent so the eye lands on now rather than on the middle of the series.
 */
export function histogram(history: readonly number[], height = 34, recent = 3) {
  const start = Math.max(0, SAMPLES - history.length)
  return Array.from({ length: SAMPLES }, (_, index) => {
    const value = index < start ? undefined : history[index - start]
    return {
      // A floor of 2px so an idle machine still reads as a series of
      // measurements rather than as a blank strip.
      height: value === undefined ? 0 : Math.max(2, Math.round(value * height)),
      recent: value !== undefined && index >= SAMPLES - recent,
    }
  })
}
