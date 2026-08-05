import { beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
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

describe("kernel metrics delta arithmetic", () => {
  test("derives percent of one core from a known cpu delta across a known window", () => {
    const sample = KernelMetrics.derive(
      { cpu_seconds: 10, at: 1_000 },
      { cpu_seconds: 12.5, memory_bytes: 4_096 },
      6_000,
    )

    expect(sample).toEqual({ cpu_percent: 50, memory_bytes: 4_096 })
  })

  test("reports past 100 for a process holding more than one core", () => {
    expect(KernelMetrics.derive({ cpu_seconds: 4, at: 0 }, { cpu_seconds: 10 }, 2_000)).toEqual({ cpu_percent: 300 })
  })

  test("reports an exact zero only when the process genuinely burned nothing", () => {
    expect(KernelMetrics.derive({ cpu_seconds: 10, at: 1_000 }, { cpu_seconds: 10 }, 3_500)).toEqual({ cpu_percent: 0 })
  })

  test("omits cpu entirely before a baseline exists, keeping the memory it did read", () => {
    expect(KernelMetrics.derive(undefined, { cpu_seconds: 12.5, memory_bytes: 4_096 }, 6_000)).toEqual({
      memory_bytes: 4_096,
    })
  })

  test("omits cpu when the window never advanced or the counter went backwards", () => {
    expect(KernelMetrics.derive({ cpu_seconds: 10, at: 6_000 }, { cpu_seconds: 12.5 }, 6_000)).toEqual({})
    expect(KernelMetrics.derive({ cpu_seconds: 10, at: 7_000 }, { cpu_seconds: 12.5 }, 6_000)).toEqual({})
    expect(KernelMetrics.derive({ cpu_seconds: 10, at: 1_000 }, { cpu_seconds: 4 }, 6_000)).toEqual({})
  })

  test("omits cpu for a sub-second window but still reports memory, rather than fabricating a value across too short a gap", () => {
    // 500ms apart — two clients on the same scoped route polling milliseconds
    // after one another, the exact corruption `ps -o time=`'s whole-second
    // resolution produces.
    expect(
      KernelMetrics.derive({ cpu_seconds: 10, at: 1_000 }, { cpu_seconds: 10.4, memory_bytes: 4_096 }, 1_500),
    ).toEqual({ memory_bytes: 4_096 })
  })

  test("still derives a value at exactly a 1 second window, the inclusive floor", () => {
    expect(KernelMetrics.derive({ cpu_seconds: 10, at: 1_000 }, { cpu_seconds: 10.5 }, 2_000)).toEqual({
      cpu_percent: 50,
    })
  })
})

describe("kernel metrics sampling", () => {
  test("reports memory immediately and cpu only once a baseline exists", async () => {
    const first = await KernelMetrics.sampleAll("kernels", [process.pid])

    expect(first.get(process.pid)?.memory_bytes).toBeGreaterThan(0)
    expect(first.get(process.pid)?.cpu_percent).toBeUndefined()

    // Cross the 1 second floor from `derive` — a shorter gap would correctly
    // omit cpu_percent as an unmeasurable window, not report a real value.
    await Bun.sleep(1_100)
    const second = await KernelMetrics.sampleAll("kernels", [process.pid])

    expect(second.get(process.pid)?.cpu_percent).toBeGreaterThanOrEqual(0)
    expect(second.get(process.pid)?.memory_bytes).toBeGreaterThan(0)
  })

  test("returns an empty map for no pids without spawning anything", async () => {
    expect((await KernelMetrics.sampleAll("kernels", [])).size).toBe(0)
  })

  test("ignores a pid that does not exist", async () => {
    const samples = await KernelMetrics.sampleAll("kernels", [process.pid, 999_999_999])

    expect(samples.has(process.pid)).toBe(true)
    expect(samples.has(999_999_999)).toBe(false)
  })

  test("keeps a pid's baseline across an interleaved sampleAll for a different pid", async () => {
    if (process.platform === "win32") return
    const a = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    const b = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    try {
      // Establish A's baseline, the way one browser tab polling session A would.
      await KernelMetrics.sampleAll("kernels", [a.pid])
      // A second tab polling a different session (B) in between — must not touch A's entry.
      await KernelMetrics.sampleAll("kernels", [b.pid])
      // Cross the 1 second floor from `derive` — a shorter gap would correctly
      // omit cpu_percent as an unmeasurable window, not report a real value.
      await Bun.sleep(1_100)
      const second = await KernelMetrics.sampleAll("kernels", [a.pid])

      expect(typeof second.get(a.pid)?.cpu_percent).toBe("number")
    } finally {
      a.kill()
      b.kill()
      await Promise.all([a.exited, b.exited])
    }
  })

  test("forgets a pid that died between two samples", async () => {
    if (process.platform === "win32") return
    const doomed = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
    const pid = doomed.pid
    const first = await KernelMetrics.sampleAll("kernels", [pid])
    doomed.kill()
    await doomed.exited

    const second = await KernelMetrics.sampleAll("kernels", [pid])

    expect(first.has(pid)).toBe(true)
    expect(second.has(pid)).toBe(false)
    // The dead pid's baseline is gone, so a pid the OS later recycles starts
    // cold rather than deriving a percentage from a stranger's cpu seconds.
    expect(KernelMetrics.tracked()).toEqual([])
  })

  test("gives each scope its own cpu window when both poll the same pid", async () => {
    if (process.platform === "win32") return
    // A real process pegged at 100% of one core, so the derived percentage is
    // large enough that a corrupted window shows up as 0 or as a wild multiple.
    const busy = Bun.spawn(["sh", "-c", "while :; do :; done"], { stdout: "ignore", stderr: "ignore" })
    const ceiling = 100 * Math.max(os.cpus().length, 4)
    try {
      // Both surfaces mount together: the Compute strip polls /notebook/compute
      // and the Kernels panel polls /notebook/kernels, milliseconds apart.
      await KernelMetrics.sampleAll("compute", [busy.pid])
      await KernelMetrics.sampleAll("kernels", [busy.pid])
      await Bun.sleep(2_500)
      const compute = await KernelMetrics.sampleAll("compute", [busy.pid])
      const kernels = await KernelMetrics.sampleAll("kernels", [busy.pid])

      for (const samples of [compute, kernels]) {
        const value = samples.get(busy.pid)?.cpu_percent
        // Never a fabricated 0 on a fully busy process, never a percentage the
        // machine could not physically produce.
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThan(ceiling)
      }
    } finally {
      busy.kill()
      await busy.exited
    }
  })
})
