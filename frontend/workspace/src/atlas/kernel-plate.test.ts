import { describe, expect, test } from "bun:test"
import type { KernelStatus } from "@/atlas/kernel-runtime"
import { plateEyebrow, plateUsage } from "./kernel-plate"

const kernel = (value: Partial<KernelStatus> = {}): KernelStatus => ({
  id: "kernel-live",
  active: true,
  state: "running",
  projectID: "project-1",
  sessionID: "ses_current",
  name: "analysis",
  language: "python",
  target: { kind: "local" },
  incarnation: 1,
  execution_count: 0,
  queue_depth: 0,
  environment: null,
  process_id: 1,
  process_started_at: null,
  process_identity_verified: null,
  started_at: null,
  last_activity_at: null,
  last_cell: null,
  ...value,
})

const host = { memory: { total: 16_400_000_000, available: 12_000_000_000 }, cpu: { cores: 8 } }

describe("kernel plate eyebrow", () => {
  test("numbers by list position and names the language", () => {
    expect(plateEyebrow(kernel(), 0)).toBe("Kernel 01 · Python")
    expect(plateEyebrow(kernel(), 9)).toBe("Kernel 10 · Python")
    expect(plateEyebrow(kernel({ language: "r" }), 1)).toBe("Kernel 02 · R")
  })
})

describe("kernel plate usage", () => {
  test("draws the kernel's own memory against the host ceiling", () => {
    const usage = plateUsage(kernel({ resources: { memory_bytes: 2_400_000_000 } }), host)

    expect(usage.ram).toBe("2.4 GB")
    expect(usage.ceiling).toBe("/ 16.4 GB")
    expect(usage.fill).toBeCloseTo(2.4 / 16.4, 3)
  })

  test("scales the kernel's memory to its own size, not the host's", () => {
    // The host total is tens of GB; a Python kernel holds tens of MB. Rendered
    // on a GB scale to one decimal every such kernel read "0.0" forever — a
    // live figure at a resolution that could never move.
    const idle = plateUsage(kernel({ resources: { memory_bytes: 16_000_000 } }), host)

    expect(idle.ram).toBe("16 MB")
    expect(idle.ceiling).toBe("/ 16.4 GB")
    // The bar is still drawn against the host, so a small kernel is a sliver.
    expect(idle.fill).toBeCloseTo(0.016 / 16.4, 4)
  })

  test("states CPU as a share of the machine, so it never exceeds 100%", () => {
    // The backend measures percent of ONE core over the process group, so a
    // kernel across nearly two cores of eight arrives as 180 and is stated as
    // 22.5% of the machine. The segments keep the core count, which is what a
    // small share hides.
    const busy = plateUsage(kernel({ resources: { cpu_percent: 180 } }), host)

    expect(busy.cpu).toBe("22.5%")
    expect(busy.segments).toBe(8)
    expect(busy.lit).toBe(2)

    // Every core saturated is exactly 100%, not 800%.
    expect(plateUsage(kernel({ resources: { cpu_percent: 800 } }), host).cpu).toBe("100.0%")
    // And a group measured slightly over its own ceiling is clamped rather
    // than printed as more than the whole machine.
    expect(plateUsage(kernel({ resources: { cpu_percent: 820 } }), host).cpu).toBe("100.0%")
  })

  test("keeps a decimal, because one core of eight is only 12.5%", () => {
    // The cost of normalising: a single-threaded kernel — most of them — can
    // never reach an eighth of this machine, so whole percents would round
    // most real work to a number that barely moves.
    expect(plateUsage(kernel({ resources: { cpu_percent: 24 } }), host).cpu).toBe("3.0%")
    expect(plateUsage(kernel({ resources: { cpu_percent: 100 } }), host).cpu).toBe("12.5%")
  })

  test("refuses to state a share of a machine it has not measured", () => {
    // Without a core count the per-core figure cannot be converted, and
    // printing it unconverted would pass 180% of one core off as 180% of the
    // host — a factor of eight, silently.
    const noCores = plateUsage(kernel({ resources: { cpu_percent: 180 } }), { memory: host.memory })

    expect(noCores.cpu).toBe("—")
    expect(noCores.segments).toBe(8)
  })

  test("lights one segment for real but sub-core work rather than reading idle", () => {
    expect(plateUsage(kernel({ resources: { cpu_percent: 4 } }), host).lit).toBe(1)
    expect(plateUsage(kernel({ resources: { cpu_percent: 0 } }), host).lit).toBe(0)
  })

  test("never lights a segment the figure beside it does not account for", () => {
    // 0.2% of one core is 0.025% of this machine, which rounds away — and a
    // lit segment beside a figure reading 0.0% is the number and the bar
    // disagreeing about the same measurement.
    const trace = plateUsage(kernel({ resources: { cpu_percent: 0.2 } }), host)

    expect(trace.cpu).toBe("0.0%")
    expect(trace.lit).toBe(0)

    // Just enough to survive the rounding lights one, and says so.
    const visible = plateUsage(kernel({ resources: { cpu_percent: 1 } }), host)

    expect(visible.cpu).toBe("0.1%")
    expect(visible.lit).toBe(1)
  })

  test("says nothing it cannot measure", () => {
    // A kernel that has not started reports no resources, and the card must not
    // fill that in with a zero that reads as a measurement.
    const unmeasured = plateUsage(kernel({ state: "lazy" }), host)

    expect(unmeasured.ram).toBe("—")
    expect(unmeasured.cpu).toBe("—")
    expect(unmeasured.fill).toBe(0)
    expect(unmeasured.lit).toBe(0)
  })

  test("drops the ceiling rather than inventing one when the host is unmeasured", () => {
    // Every section of the capacity body is optional, so a poll that lost the
    // memory section must cost the ceiling and nothing else.
    const partial = plateUsage(kernel({ resources: { memory_bytes: 2_400_000_000, cpu_percent: 100 } }), {
      cpu: { cores: 4 },
    })

    expect(partial.ram).toBe("2.4 GB")
    expect(partial.ceiling).toBe("")
    expect(partial.fill).toBe(0)
    expect(partial.segments).toBe(4)

    const none = plateUsage(kernel({ resources: { memory_bytes: 1_000_000_000 } }), undefined)
    expect(none.ceiling).toBe("")
    expect(none.segments).toBe(8)
  })
})
