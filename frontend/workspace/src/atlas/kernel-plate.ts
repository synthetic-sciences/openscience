import type { Capacity } from "./host-instruments"
import { kernelCpuLabel, kernelMemoryLabel, type KernelStatus } from "@/notebook/runtime"

/**
 * The figures 3a keeps visible on a collapsed kernel plate.
 *
 * The plate collapses to a head, so whatever survives the collapse is the whole
 * answer to "is this runtime in my way". 3a keeps two: how much of the host's
 * memory this kernel holds, and how many of its cores the kernel is turning.
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
  /** Utilisation as the ledger states it, on the Unix convention the backend
   *  measures in: 100% is one core saturated, so a kernel across two cores
   *  reads about 200%. Stated as a percentage rather than a core count because
   *  that is the figure actually measured — and because a single-threaded
   *  Python kernel, which is most of them, lives between 0 and 100% and would
   *  otherwise read "0 of 8" no matter how hard it was working. */
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

  // A kernel can turn more than one core, so this is not a percentage of the
  // machine — it is how many cores' worth of work it is doing right now.
  const turning =
    percent === undefined || percent === null || !Number.isFinite(percent) ? undefined : Math.max(0, percent) / 100

  const segments = cores === undefined ? 8 : Math.min(12, Math.max(1, Math.round(cores)))

  return {
    // The same helper the opened ledger uses, for the same reason as cpu: one
    // measurement, one unit, wherever it is stated.
    ram: used === undefined ? "—" : kernelMemoryLabel(bytes),
    ceiling: total === undefined ? "" : `/ ${total.toFixed(1)} GB`,
    fill: used === undefined || total === undefined || total <= 0 ? 0 : Math.min(1, used / total),
    // The same helper the opened ledger uses, so the head and the row beneath
    // it cannot disagree about one measurement.
    cpu: percent === undefined || percent === null ? "—" : kernelCpuLabel(percent),
    segments,
    // The segments still count cores: they are what makes multi-core work
    // legible at a glance, which a bare percentage does not. Rounded up, so a
    // kernel doing real but sub-core work lights one rather than reading idle.
    lit: turning === undefined ? 0 : Math.min(segments, Math.ceil(turning)),
  }
}
