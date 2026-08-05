import { beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
import { KernelHost } from "../../../src/science/kernel/host"

// The baseline is module state shared with every other caller in the process,
// so each test starts cold rather than depending on being the first to sample.
beforeEach(() => KernelHost.reset())

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
    // Cross the 1 second floor `advance` applies — a shorter gap would
    // correctly report nothing rather than trust a window in which barely a
    // jiffy ticked. Still far below the 200ms a cold sample would cost plus the
    // sleep itself, so this proves the warm path never blocks.
    await Bun.sleep(1_100)
    const started = Date.now()
    const snapshot = await KernelHost.snapshot()

    expect(Date.now() - started).toBeLessThan(150)
    expect(snapshot.cpu.busy).toBeGreaterThanOrEqual(0)
  })

  test("keeps the older baseline when the window produced no reading", () => {
    const previous = { times: { active: 1_000, total: 10_000 }, at: 1_000 }
    const fresh = { times: { active: 1_000, total: 10_000 }, at: 2_050 }
    const result = KernelHost.advance(previous, fresh, 8)

    expect(result.reading).toEqual({})
    expect(result.baseline).toBe(previous)
  })

  test("advances the baseline only once the window produced a reading", () => {
    const previous = { times: { active: 1_000, total: 10_000 }, at: 1_000 }
    const fresh = { times: { active: 1_500, total: 12_000 }, at: 2_050 }
    const result = KernelHost.advance(previous, fresh, 8)

    expect(result.reading.busy).toBeCloseTo(2, 5)
    expect(result.baseline).toBe(fresh)
  })

  test("reports nothing across a sub-second window instead of a jiffy's worth of noise", () => {
    // Two /notebook/compute requests milliseconds apart: the second measures a
    // span in which one core has ticked once. Counted as idle that reads
    // `busy: 0` on a machine running at three cores; counted as active it reads
    // every core pegged. Both are noise dressed as a measurement, so the window
    // is refused and the older baseline held for the next call.
    const previous = { times: { active: 1_000, total: 10_000 }, at: 1_000 }
    const idle = { times: { active: 1_000, total: 10_010 }, at: 1_001 }
    const active = { times: { active: 1_010, total: 10_010 }, at: 1_001 }

    expect(KernelHost.advance(previous, idle, 8).reading).toEqual({})
    expect(KernelHost.advance(previous, idle, 8).baseline).toBe(previous)
    expect(KernelHost.advance(previous, active, 8).reading).toEqual({})
    expect(KernelHost.advance(previous, active, 8).baseline).toBe(previous)
  })

  test("still measures at exactly a 1 second window, the inclusive floor", () => {
    const previous = { times: { active: 1_000, total: 10_000 }, at: 1_000 }
    const fresh = { times: { active: 1_500, total: 12_000 }, at: 2_000 }

    expect(KernelHost.advance(previous, fresh, 8).reading.busy).toBeCloseTo(2, 5)
  })

  test("never answers concurrent snapshots with a fabricated 0 or a fully pegged host", async () => {
    // The empirical half of the floor: real concurrent callers against the real
    // rolling baseline, with one core genuinely held so neither extreme can be
    // the truth. 5ms straddles the 10ms jiffy, so a window in which exactly one
    // core ticked once — the corruption the floor exists to refuse — happens
    // repeatedly over 60 rounds.
    const spinner = Bun.spawn(["sh", "-c", "while :; do :; done"], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      const cores = os.cpus().length
      const readings: Array<number | undefined> = []
      for (let round = 0; round < 60; round += 1) {
        const pair = await Promise.all([KernelHost.snapshot(), KernelHost.snapshot()])
        readings.push(...pair.map((snapshot) => snapshot.cpu.busy))
        await Bun.sleep(5)
      }

      expect(readings.length).toBe(120)
      // Non-vacuous: refusing every window would satisfy the loop below, so at
      // least one round must have produced a real figure — the cold sample's,
      // which measures its own 200ms and sees the spinner.
      const measured = readings.filter((value) => value !== undefined)
      expect(measured.length).toBeGreaterThan(0)
      for (const value of measured) {
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThan(cores)
      }
    } finally {
      spinner.kill()
      await spinner.exited
    }
  }, 30_000)
})
