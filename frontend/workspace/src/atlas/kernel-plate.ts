import type { Capacity } from "./host-instruments"
import { kernelMemoryLabel, type KernelStatus } from "@/notebook/runtime"

/**
 * The figures 3a keeps visible on a collapsed kernel plate.
 *
 * The plate collapses to a head, so whatever survives the collapse is the whole
 * answer to "is this runtime in my way". 3a keeps two: how much of the host's
 * memory this kernel holds, and what share of its CPU the kernel is taking.
 *
 * Pure and separate from the component for the same reason host-instruments.ts
 * is: these are the numbers most likely to be wrong, and asserting them should
 * not require mounting a card or standing up a server.
 */

export type Usage = {
  /** The kernel's own memory, in whatever unit fits it, or "—" when
   *  unmeasured. Adaptive rather than fixed to GB: the host total is tens of
   *  GB, but a Python kernel holds tens of MB, and rendering that against a GB
   *  scale to one decimal printed "0.0" for every kernel that was not a
   *  training run — a live figure at a resolution that could never move. */
  ram: string
  /** The host ceiling it is drawn against, e.g. "/ 16.4 GB". Empty when the
   *  host never reported a total — a bare number with no ceiling is honest,
   *  a ceiling invented from the browser's own machine is not. */
  ceiling: string
  /** 0–1, for the bar's width. */
  fill: number
  /** Utilisation as a share of the whole machine, so it never exceeds 100%.
   *
   *  The backend measures percent of ONE core over the kernel's process group
   *  (metrics.ts:96), which is the `top` convention and reads 300 for a kernel
   *  across three cores. That is divided by the host's core count here.
   *
   *  The cost is resolution: on an 8-core box a single-threaded kernel — most
   *  of them — can only ever reach 12.5%, so the figure is kept to one decimal
   *  and the segments below carry the core count that a small share hides. */
  cpu: string
  segments: number
  lit: number
}

const gb = (bytes?: number | null) => {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return undefined
  return bytes / 1_000_000_000
}

const language = (kernel: KernelStatus) => {
  if (kernel.language === "python") return "Python"
  if (kernel.language === "r") return "R"
  return kernel.language.charAt(0).toUpperCase() + kernel.language.slice(1)
}

/**
 * "Kernel 01 · Python" — the plate's eyebrow.
 *
 * The ordinal is the kernel's position in the rendered list, not an id: the
 * point is to tell two plates apart at a glance while they are collapsed, and
 * a runtime id is far too long to read at eyebrow size.
 */
export function plateEyebrow(kernel: KernelStatus, index: number): string {
  return `Kernel ${String(index + 1).padStart(2, "0")} · ${language(kernel)}`
}

/**
 * Takes a PARTIAL capacity for the reason hostReading does: the compute route
 * omits any figure it could not measure, so every section is guarded on its own
 * and a body missing one degrades only that figure.
 */
export function plateUsage(kernel: KernelStatus, capacity?: Partial<Capacity>): Usage {
  const bytes = kernel.resources?.memory_bytes
  const used = gb(bytes)
  const total = gb(capacity?.memory?.total)
  const percent = kernel.resources?.cpu_percent
  const cores = capacity?.cpu?.cores

  // What the backend measures is percent of ONE core (metrics.ts:96), taken
  // over the kernel's whole process group — so a kernel whose BLAS threads
  // occupy three cores arrives here as 300. Divided out, this is how many
  // cores' worth of work it is doing.
  const turning =
    percent === undefined || percent === null || !Number.isFinite(percent) ? undefined : Math.max(0, percent) / 100

  const segments = cores === undefined ? 8 : Math.min(12, Math.max(1, Math.round(cores)))

  // ...and this is that same work as a share of the whole machine, which is
  // what the card states. It needs the host's core count, so a body that never
  // reported one leaves this unmeasurable rather than passing off a per-core
  // figure as a machine one — those differ by 8x here, silently.
  const share =
    turning === undefined || cores === undefined || cores <= 0 ? undefined : Math.min(100, (turning / cores) * 100)
  // Rounded once, here, so the figure and the segments below it are two views
  // of one number rather than two roundings of it. Reading each independently
  // is what let a kernel at 0.4% of one core light a whole segment while the
  // figure beside it said 0.0%.
  const shown = share === undefined ? undefined : Number(share.toFixed(1))

  return {
    // The same helper the opened ledger uses, for the same reason as cpu: one
    // measurement, one unit, wherever it is stated.
    ram: used === undefined ? "—" : kernelMemoryLabel(bytes),
    ceiling: total === undefined ? "" : `/ ${total.toFixed(1)} GB`,
    fill: used === undefined || total === undefined || total <= 0 ? 0 : Math.min(1, used / total),
    cpu: shown === undefined ? "—" : `${shown.toFixed(1)}%`,
    segments,
    // The segments carry the core count that a share of a big machine hides:
    // 23.4% says little, two of eight segments says "two cores". Rounded up, so
    // a kernel doing real but sub-core work lights one rather than reading
    // idle — but only once it is doing enough to show in the figure at all.
    lit: turning === undefined || !shown ? 0 : Math.min(segments, Math.ceil(turning)),
  }
}
