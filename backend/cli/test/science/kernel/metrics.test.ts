import { beforeEach, describe, expect, test } from "bun:test"
import { KernelMetrics } from "../../../src/science/kernel/metrics"

beforeEach(() => KernelMetrics.reset())

describe("kernel metrics parsing", () => {
  test("parses every ps cumulative time format", () => {
    expect(KernelMetrics.seconds("0:04")).toBe(4)
    expect(KernelMetrics.seconds("12:34")).toBe(754)
    expect(KernelMetrics.seconds("1:02:03")).toBe(3_723)
    expect(KernelMetrics.seconds("2-03:04:05")).toBe(183_845)
  })

  test("rejects unparseable time rather than returning a partial number", () => {
    expect(KernelMetrics.seconds("")).toBeUndefined()
    expect(KernelMetrics.seconds("??")).toBeUndefined()
  })

  test("reads pid, cumulative seconds and resident kilobytes from ps output", () => {
    const readings = KernelMetrics.unix("  4821 1:02:03 412000\n  4822 0:04 88240\n")

    expect(readings.get(4821)).toEqual({ cpu_seconds: 3_723, memory_bytes: 412_000 * 1024 })
    expect(readings.get(4822)).toEqual({ cpu_seconds: 4, memory_bytes: 88_240 * 1024 })
  })

  test("reads pid, cumulative seconds and bytes from Get-Process output", () => {
    const readings = KernelMetrics.windows("4821 12.484375 421888000\n4822 0.15625 90357760\n")

    expect(readings.get(4821)).toEqual({ cpu_seconds: 12.484375, memory_bytes: 421_888_000 })
    expect(readings.get(4822)?.cpu_seconds).toBeCloseTo(0.15625, 6)
  })

  test("drops a Windows row whose CPU is null because the process could not be read", () => {
    const readings = KernelMetrics.windows("4821  421888000\n")

    expect(readings.get(4821)).toBeUndefined()
  })

  test("yields nothing rather than NaN for unparseable output", () => {
    expect(KernelMetrics.unix("garbage\n").size).toBe(0)
    expect(KernelMetrics.windows("garbage\n").size).toBe(0)
    expect(KernelMetrics.unix("").size).toBe(0)
  })
})

describe("kernel metrics sampling", () => {
  test("reports memory immediately and cpu only once a baseline exists", async () => {
    const first = await KernelMetrics.sampleAll([process.pid])

    expect(first.get(process.pid)?.memory_bytes).toBeGreaterThan(0)
    expect(first.get(process.pid)?.cpu_percent).toBeUndefined()

    await Bun.sleep(120)
    const second = await KernelMetrics.sampleAll([process.pid])

    expect(second.get(process.pid)?.cpu_percent).toBeGreaterThanOrEqual(0)
    expect(second.get(process.pid)?.memory_bytes).toBeGreaterThan(0)
  })

  test("returns an empty map for no pids without spawning anything", async () => {
    expect((await KernelMetrics.sampleAll([])).size).toBe(0)
  })

  test("ignores a pid that does not exist", async () => {
    const samples = await KernelMetrics.sampleAll([process.pid, 999_999_999])

    expect(samples.has(process.pid)).toBe(true)
    expect(samples.has(999_999_999)).toBe(false)
  })

  test("keeps a pid's baseline across an interleaved sampleAll for a different pid", async () => {
    if (process.platform === "win32") return
    const a = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    const b = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    try {
      // Establish A's baseline, the way one browser tab polling session A would.
      await KernelMetrics.sampleAll([a.pid])
      // A second tab polling a different session (B) in between — must not touch A's entry.
      await KernelMetrics.sampleAll([b.pid])
      await Bun.sleep(120)
      const second = await KernelMetrics.sampleAll([a.pid])

      expect(typeof second.get(a.pid)?.cpu_percent).toBe("number")
    } finally {
      a.kill()
      b.kill()
      await Promise.all([a.exited, b.exited])
    }
  })
})
