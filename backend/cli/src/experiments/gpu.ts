import z from "zod"
import { ProcessOutput } from "@/util/process-output"

/** Local GPU inventory for slotting study runs and for the Compute strip. */
export namespace GpuInventory {
  export const Gpu = z
    .object({
      index: z.number().int().nonnegative(),
      name: z.string(),
      memoryTotalMB: z.number().nonnegative(),
      memoryUsedMB: z.number().nonnegative(),
      utilization: z.number().min(0).max(100),
      temperatureC: z.number().nullable(),
    })
    .meta({ ref: "LocalGpu" })
  export type Gpu = z.infer<typeof Gpu>

  const cache = { at: 0, gpus: [] as Gpu[], available: undefined as boolean | undefined }
  const TTL_MS = 4_000

  export function parse(csv: string): Gpu[] {
    return csv
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const cells = line.split(",").map((cell) => cell.trim())
        if (cells.length < 5) return []
        const number = (value: string | undefined) => {
          const parsed = Number(value)
          return Number.isFinite(parsed) ? parsed : 0
        }
        return [
          {
            index: number(cells[0]),
            name: cells[1] ?? "GPU",
            memoryTotalMB: number(cells[2]),
            memoryUsedMB: number(cells[3]),
            utilization: Math.min(100, Math.max(0, number(cells[4]))),
            temperatureC: cells[5] === undefined || cells[5] === "" || cells[5] === "[N/A]" ? null : number(cells[5]),
          },
        ]
      })
  }

  /** The current inventory; empty on hosts without nvidia-smi. */
  export async function list(options: { fresh?: boolean } = {}): Promise<Gpu[]> {
    if (!options.fresh && Date.now() - cache.at < TTL_MS) return cache.gpus
    if (cache.available === false && !options.fresh) return []
    const binary = Bun.which("nvidia-smi")
    if (!binary) {
      cache.available = false
      cache.at = Date.now()
      cache.gpus = []
      return []
    }
    const proc = Bun.spawn(
      [
        binary,
        "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    )
    const result = await ProcessOutput.collect(proc, { maxBytes: 64 * 1024, timeoutMs: 5_000 }).catch(() => undefined)
    cache.at = Date.now()
    cache.available = !!result && result.code === 0
    cache.gpus = cache.available ? parse(result!.bytes.toString()) : []
    return cache.gpus
  }

  /** Slots a study may use: one per GPU, or a single CPU slot without GPUs. */
  export async function slots(): Promise<number[]> {
    const gpus = await list()
    return gpus.length ? gpus.map((gpu) => gpu.index) : [0]
  }
}
