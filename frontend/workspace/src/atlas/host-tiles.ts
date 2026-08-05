import { kernelMemoryLabel } from "@/notebook/runtime"

export type Capacity = {
  memory: { total: number; available: number; kernels?: number }
  cpu: { cores: number; busy?: number; kernels?: number }
  kernels: { live: number; running: number }
}

const ratio = (value: number, of: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(of) || of <= 0) return 0
  return Math.min(1, Math.max(0, value / of))
}

const cores = (value?: number) => (value === undefined ? "Unavailable" : `${value.toFixed(1)} cores`)

// Takes a PARTIAL capacity, because that is what a body can really be: the
// route omits any figure it could not measure, and a version skew or a
// half-written response can drop a whole section. Each tile is guarded on its
// own section so a body missing one degrades only that tile — dereferencing an
// absent section would throw inside HostStrip's createMemo, and the nearest
// ErrorBoundary wraps the entire workspace.
//
// Pure so the tiles can be asserted without mounting or a live server.
export function hostTiles(capacity?: Partial<Capacity>) {
  const memory = capacity?.memory
  const cpu = capacity?.cpu
  const kernels = capacity?.kernels
  const used = memory ? memory.total - memory.available : 0
  return [
    {
      key: "memory",
      value: kernelMemoryLabel(memory?.kernels),
      caption: memory
        ? `kernels · ${kernelMemoryLabel(memory.available)} free of ${kernelMemoryLabel(memory.total)}`
        : "kernels · capacity unavailable",
      fill: memory ? ratio(used, memory.total) : 0,
      share: memory ? ratio(memory.kernels ?? 0, memory.total) : 0,
    },
    {
      key: "cpu",
      value: cores(cpu?.kernels),
      caption: cpu
        ? cpu.busy === undefined
          ? `by kernels · ${cpu.cores} cores`
          : `by kernels · ~${Math.round(cpu.busy)} of ${cpu.cores} cores busy`
        : "by kernels · capacity unavailable",
      fill: cpu ? ratio(cpu.busy ?? 0, cpu.cores) : 0,
      share: cpu ? ratio(cpu.kernels ?? 0, cpu.cores) : 0,
    },
    {
      key: "kernels",
      value: kernels ? `${kernels.live}` : "Unavailable",
      caption: kernels ? `kernels · ${kernels.running} running` : "kernels · count unavailable",
      fill: 0,
      share: 0,
    },
  ]
}
