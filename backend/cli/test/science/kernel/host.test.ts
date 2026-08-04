import { describe, expect, test } from "bun:test"
import os from "node:os"
import { KernelHost } from "../../../src/science/kernel/host"

const meminfo = `MemTotal:       16318000 kB
MemFree:         1402184 kB
MemAvailable:    9300000 kB
Buffers:          312000 kB
`

describe("kernel host snapshot", () => {
  test("prefers MemAvailable over MemFree so page cache counts as free", () => {
    expect(KernelHost.available(meminfo)).toBe(9_300_000 * 1024)
  })

  test("reports no value when meminfo is absent or malformed", () => {
    expect(KernelHost.available("")).toBeUndefined()
    expect(KernelHost.available("MemAvailable: not-a-number kB")).toBeUndefined()
    expect(KernelHost.available("MemFree: 1402184 kB")).toBeUndefined()
  })

  test("derives busy cores from the active share of total processor time", () => {
    const prev = { active: 1_000, total: 10_000 }
    const next = { active: 1_500, total: 12_000 }

    expect(KernelHost.busy(prev, next, 8)).toBeCloseTo(2, 5)
  })

  test("clamps busy cores into range and rejects a non-advancing sample", () => {
    expect(KernelHost.busy({ active: 0, total: 0 }, { active: 500, total: 1_000 }, 4)).toBeCloseTo(2, 5)
    expect(KernelHost.busy({ active: 0, total: 1_000 }, { active: 0, total: 1_000 }, 4)).toBeUndefined()
    expect(KernelHost.busy({ active: 0, total: 0 }, { active: 2_000, total: 1_000 }, 4)).toBe(4)
  })

  test("sums active and idle time across every core", () => {
    const cpus = [
      { times: { user: 100, nice: 10, sys: 40, idle: 850, irq: 0 } },
      { times: { user: 200, nice: 0, sys: 60, idle: 740, irq: 0 } },
    ] as os.CpuInfo[]

    expect(KernelHost.times(cpus)).toEqual({ active: 410, total: 2_000 })
  })

  test("reports real machine capacity within physical bounds", async () => {
    const snapshot = await KernelHost.snapshot()

    expect(snapshot.memory.total).toBeGreaterThan(0)
    expect(snapshot.memory.available).toBeGreaterThan(0)
    expect(snapshot.memory.available).toBeLessThanOrEqual(snapshot.memory.total)
    expect(snapshot.cpu.cores).toBeGreaterThanOrEqual(1)
    expect(snapshot.cpu.busy).toBeGreaterThanOrEqual(0)
    expect(snapshot.cpu.busy).toBeLessThanOrEqual(snapshot.cpu.cores)
  })

  test("serves the second snapshot from the rolling baseline without a blocking sample", async () => {
    await KernelHost.snapshot()
    const started = Date.now()
    const snapshot = await KernelHost.snapshot()

    expect(Date.now() - started).toBeLessThan(150)
    expect(snapshot.cpu.busy).toBeGreaterThanOrEqual(0)
  })
})
