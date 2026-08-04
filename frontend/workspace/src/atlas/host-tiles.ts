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

// Pure so the tiles can be asserted without mounting or a live server.
export function hostTiles(capacity?: Capacity) {
  const memory = capacity?.memory
  const cpu = capacity?.cpu
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
      value: capacity ? `${capacity.kernels.live}` : "Unavailable",
      caption: capacity ? `kernels · ${capacity.kernels.running} running` : "kernels · count unavailable",
      fill: 0,
      share: 0,
    },
  ]
}
