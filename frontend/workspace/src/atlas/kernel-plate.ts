import type { Capacity } from "./host-instruments"
import { kernelCpuLabel, kernelMemoryLabel, type KernelStatus } from "@/notebook/runtime"

/**
 * The figures 3a keeps visible on a collapsed kernel plate.
 *
 * The plate collapses to a head, so whatever survives the collapse is the whole
 * answer to "is this runtime in my way". 3a keeps two: how much of the host's
 * memory this kernel holds, and how hard it is working the CPU.
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
  /** What this kernel is using, as the backend measures it: percent of ONE
   *  core over the kernel's process group (metrics.ts:96, the `top`
   *  convention). A kernel across three cores reads 300%.
   *
   *  Deliberately not divided by the host's core count. That would cap it at
   *  100% but make it a statement about the machine rather than about this
   *  kernel — and on an 8-core box it would leave a single-threaded kernel,
   *  which is most of them, unable to read above 12.5% however hard it works.
   *  The segments below carry the machine's scale instead. */
  cpu: string
  segments: number
  lit: number
}

const gb = (bytes?: number | null) => {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return undefined
  return bytes / 1_000_000_000
}

const language = (kernel: KernelStatus) => {
  if (kernel.language === "python") return "PYTHON"
  if (kernel.language === "r") return "R"
  return kernel.language.toUpperCase()
}

/**
 * "KERNEL 01 · PYTHON" — the plate's eyebrow.
 *
 * The ordinal is the kernel's position in the rendered list, not an id: the
 * point is to tell two plates apart at a glance while they are collapsed, and
 * a runtime id is far too long to read at eyebrow size.
 */
export function plateEyebrow(kernel: KernelStatus, index: number): string {
  return `KERNEL ${String(index + 1).padStart(2, "0")} · ${language(kernel)}`
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
  // occupy three cores arrives here as 300. That figure is what the card
  // states; divided by 100 it is also how many cores the kernel occupies,
  // which is what lights the segments.
  const measured =
    percent === undefined || percent === null || !Number.isFinite(percent) ? undefined : Math.max(0, percent)
  const turning = measured === undefined ? undefined : measured / 100

  const segments = cores === undefined ? 8 : Math.min(12, Math.max(1, Math.round(cores)))

  return {
    // The same helper the opened ledger uses, for the same reason as cpu: one
    // measurement, one unit, wherever it is stated.
    ram: used === undefined ? "—" : kernelMemoryLabel(bytes),
    ceiling: total === undefined ? "" : `/ ${total.toFixed(1)} GB`,
    fill: used === undefined || total === undefined || total <= 0 ? 0 : Math.min(1, used / total),
    // The same helper the opened ledger uses, so the head and the row beneath
    // it cannot disagree about one measurement. Independent of the host, so a
    // poll that lost the cpu section costs the segments and not this figure.
    cpu: measured === undefined ? "—" : kernelCpuLabel(measured),
    segments,
    // The segments still count cores: they are what makes multi-core work
    // legible at a glance, which a bare percentage does not. Rounded up, so a
    // kernel doing real but sub-core work lights one rather than reading idle.
    lit: turning === undefined ? 0 : Math.min(segments, Math.ceil(turning)),
  }
}
