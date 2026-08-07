export type Capacity = {
  memory: { total: number; available: number; kernels?: number }
  cpu: { cores: number; busy?: number; kernels?: number }
  kernels: { live: number; running: number }
}

export type Reading = {
  /** The figure set at display size: memory in use, against the total below
   *  it. Used rather than free, so the headline agrees with the histogram
   *  beside it — the bars encode the fraction in use, and a headline counting
   *  down while the bars climb made the two read as different measurements. */
  headline: string
  /** Stacked beneath the headline: the unit, then the ceiling. */
  unit: string
  ceiling: string
  /** Cores are countable, so they stay discrete. */
  segments: number
  lit: number
  cores: string
}

const ratio = (value: number, of: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(of) || of <= 0) return 0
  return Math.min(1, Math.max(0, value / of))
}

const gb = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return (value / 1_000_000_000).toFixed(1)
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
  // Derived rather than reported: the route carries total and available, and
  // subtracting is the only figure consistent with the histogram's ratio.
  const used =
    memory?.total === undefined || memory?.available === undefined
      ? undefined
      : gb(Math.max(0, memory.total - memory.available))
  const cores = cpu?.cores
  const busy = cpu?.busy
  const segments = cores === undefined ? 8 : Math.min(12, Math.max(1, Math.round(cores)))

  return {
    headline: used ?? "—",
    unit: used === undefined ? "Unavailable" : "GB used",
    ceiling: total ? `of ${total}` : "",
    segments,
    lit: cores === undefined ? 0 : Math.round(ratio(busy ?? 0, cores) * segments),
    cores: cores === undefined ? "—" : `${busy === undefined ? 0 : Math.round(busy)} / ${cores}`,
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
