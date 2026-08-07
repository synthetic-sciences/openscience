import { describe, expect, test } from "bun:test"
import type { KernelStatus } from "@/notebook/runtime"
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
  ...value,
})

const host = { memory: { total: 16_400_000_000, available: 12_000_000_000 }, cpu: { cores: 8 } }

describe("kernel plate eyebrow", () => {
  test("numbers by list position and names the language", () => {
    expect(plateEyebrow(kernel(), 0)).toBe("KERNEL 01 · PYTHON")
    expect(plateEyebrow(kernel(), 9)).toBe("KERNEL 10 · PYTHON")
    expect(plateEyebrow(kernel({ language: "r" }), 1)).toBe("KERNEL 02 · R")
  })
})

describe("kernel plate usage", () => {
  test("draws the kernel's own memory against the host ceiling", () => {
    const usage = plateUsage(kernel({ resources: { memory_bytes: 2_400_000_000 } }), host)

    expect(usage.ram).toBe("2.4")
    expect(usage.ceiling).toBe("/ 16.4 GB")
    expect(usage.fill).toBeCloseTo(2.4 / 16.4, 3)
  })

  test("counts cores turned rather than a percentage of the machine", () => {
    // 180% is a kernel using nearly two cores, not 180% of the host.
    const usage = plateUsage(kernel({ resources: { cpu_percent: 180 } }), host)

    expect(usage.cores).toBe("2")
    expect(usage.segments).toBe(8)
    expect(usage.lit).toBe(2)
  })

  test("lights one segment for real but sub-core work rather than reading idle", () => {
    expect(plateUsage(kernel({ resources: { cpu_percent: 4 } }), host).lit).toBe(1)
    expect(plateUsage(kernel({ resources: { cpu_percent: 0 } }), host).lit).toBe(0)
  })

  test("says nothing it cannot measure", () => {
    // A kernel that has not started reports no resources, and the card must not
    // fill that in with a zero that reads as a measurement.
    const unmeasured = plateUsage(kernel({ state: "lazy" }), host)

    expect(unmeasured.ram).toBe("—")
    expect(unmeasured.cores).toBe("—")
    expect(unmeasured.fill).toBe(0)
    expect(unmeasured.lit).toBe(0)
  })

  test("drops the ceiling rather than inventing one when the host is unmeasured", () => {
    // Every section of the capacity body is optional, so a poll that lost the
    // memory section must cost the ceiling and nothing else.
    const partial = plateUsage(kernel({ resources: { memory_bytes: 2_400_000_000, cpu_percent: 100 } }), {
      cpu: { cores: 4 },
    })

    expect(partial.ram).toBe("2.4")
    expect(partial.ceiling).toBe("")
    expect(partial.fill).toBe(0)
    expect(partial.segments).toBe(4)

    const none = plateUsage(kernel({ resources: { memory_bytes: 1_000_000_000 } }), undefined)
    expect(none.ceiling).toBe("")
    expect(none.segments).toBe(8)
  })
})
