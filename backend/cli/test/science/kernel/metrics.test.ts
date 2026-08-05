import { $ } from "bun"
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

  test("reads pid, pgid, cumulative seconds and resident kilobytes from ps output", () => {
    const rows = KernelMetrics.unix("  4821 4821 1:02:03 412000\n  4822 5000 0:04 88240\n")

    expect(rows).toEqual([
      { pid: 4821, pgid: 4821, cpu_seconds: 3_723, memory_bytes: 412_000 * 1024 },
      { pid: 4822, pgid: 5000, cpu_seconds: 4, memory_bytes: 88_240 * 1024 },
    ])
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
    expect(KernelMetrics.unix("garbage\n").length).toBe(0)
    expect(KernelMetrics.windows("garbage\n").size).toBe(0)
    expect(KernelMetrics.unix("").length).toBe(0)
  })

  test("drops a row whose pgid could not be read rather than grouping it under NaN", () => {
    const rows = KernelMetrics.unix("4821 ? 1:02:03 412000\n")

    expect(rows).toEqual([])
  })
})

describe("kernel metrics process-group summing", () => {
  // Fixture shaped like `ps -Ao pid=,pgid=,time=,rss=`: two unrelated kernel
  // process groups (100 and 200, each a leader plus descendants sharing its
  // pgid, exactly what notebook.ts's detached: true spawn produces) plus a
  // third, unrelated group (999) nobody asked about.
  const rows = KernelMetrics.unix(
    [
      "100 100 0:10 100000", // kernel A leader
      "101 100 0:05 50000", //  kernel A's forked interpreter
      "200 200 1:00 200000", // kernel B leader
      "201 200 0:30 80000", //  kernel B's interpreter
      "202 200 0:15 40000", //  a joblib worker kernel B's interpreter forked
      "999 999 5:00 999999", // an unrelated process on the host
    ].join("\n"),
  )

  test("sums every row in a wanted group into one reading", () => {
    const readings = KernelMetrics.group(rows, [100, 200])

    expect(readings.get(100)).toEqual({ cpu_seconds: 15, memory_bytes: 150_000 * 1024 })
    expect(readings.get(200)).toEqual({ cpu_seconds: 105, memory_bytes: 320_000 * 1024 })
  })

  test("never lets an unrelated group's rows bleed into a wanted group's sum", () => {
    const readings = KernelMetrics.group(rows, [100])

    expect(readings.size).toBe(1)
    expect(readings.has(200)).toBe(false)
    expect(readings.has(999)).toBe(false)
  })

  test("reports nothing for a pgid no row on the host belongs to", () => {
    const readings = KernelMetrics.group(rows, [100, 777])

    expect(readings.has(777)).toBe(false)
  })

  test("omits memory for a group whose rows never reported a resident size, never fabricating a 0", () => {
    const noMemory = KernelMetrics.unix("300 300 0:01 abc\n301 300 0:02 xyz\n")

    const readings = KernelMetrics.group(noMemory, [300])

    expect(readings.get(300)).toEqual({ cpu_seconds: 3 })
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
  // Every sampled pid below is spawned with detached: true, exactly like
  // notebook.ts spawns a kernel — that is what makes the pid its own process
  // GROUP leader (pgid === its own pid). Sampling now reads by process group
  // (see the fix this guards), so a pid that is NOT a group leader — e.g.
  // this test runner's own process.pid, or a plain Bun.spawn child sharing
  // the runner's pgid — would not be found at all. These tests exercise the
  // same real spawn shape production relies on rather than that mismatch.
  test("reports memory immediately and cpu only once a baseline exists", async () => {
    if (process.platform === "win32") return
    const kernel = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" })
    try {
      const first = await KernelMetrics.sampleAll("kernels", [kernel.pid])

      expect(first.get(kernel.pid)?.memory_bytes).toBeGreaterThan(0)
      expect(first.get(kernel.pid)?.cpu_percent).toBeUndefined()

      // Cross the 1 second floor from `derive` — a shorter gap would correctly
      // omit cpu_percent as an unmeasurable window, not report a real value.
      await Bun.sleep(1_100)
      const second = await KernelMetrics.sampleAll("kernels", [kernel.pid])

      expect(second.get(kernel.pid)?.cpu_percent).toBeGreaterThanOrEqual(0)
      expect(second.get(kernel.pid)?.memory_bytes).toBeGreaterThan(0)
    } finally {
      kernel.kill()
      await kernel.exited
    }
  })

  test("returns an empty map for no pids without spawning anything", async () => {
    expect((await KernelMetrics.sampleAll("kernels", [])).size).toBe(0)
  })

  test("ignores a pid that does not exist", async () => {
    if (process.platform === "win32") return
    const kernel = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" })
    try {
      const samples = await KernelMetrics.sampleAll("kernels", [kernel.pid, 999_999_999])

      expect(samples.has(kernel.pid)).toBe(true)
      expect(samples.has(999_999_999)).toBe(false)
    } finally {
      kernel.kill()
      await kernel.exited
    }
  })

  test("keeps a pid's baseline across an interleaved sampleAll for a different pid", async () => {
    if (process.platform === "win32") return
    const a = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" })
    const b = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" })
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
    const doomed = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" })
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
    const busy = Bun.spawn(["sh", "-c", "while :; do :; done"], { detached: true, stdout: "ignore", stderr: "ignore" })
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

  test("sums a real forked descendant's memory into the group, exceeding what the leader alone holds", async () => {
    if (process.platform === "win32") return
    // Mirrors notebook.ts's real spawn shape: detached: true makes this
    // process its own process-group leader (pgid === its own pid), exactly
    // like the kernel's bwrap/python leader in production. It forks a
    // grandchild that holds real memory the leader itself never touches —
    // the same shape as a kernel's interpreter forking a joblib/BLAS worker.
    const script = [
      "import os, sys, time",
      "child = os.fork()",
      "if child == 0:",
      "    sys.stdout.write(f'CHILD={os.getpid()}\\n')",
      "    sys.stdout.flush()",
      "    buf = bytearray(64 * 1024 * 1024)",
      "    buf[0] = 1",
      "    time.sleep(30)",
      "else:",
      "    time.sleep(30)",
    ].join("\n")
    const leader = Bun.spawn(["python3", "-c", script], { detached: true, stdout: "pipe", stderr: "ignore" })

    // Read only until the grandchild's pid announces itself — the pipe's
    // write end stays open in both processes until they exit 30s later, so
    // reading it to completion here would hang the test.
    const reader = leader.stdout.getReader()
    const decoder = new TextDecoder()
    let announced = ""
    while (!announced.includes("CHILD=")) {
      const { value, done } = await reader.read()
      if (done) break
      announced += decoder.decode(value)
    }
    const grandchild = Number.parseInt(announced.trim().split("CHILD=")[1] ?? "", 10)

    try {
      expect(Number.isFinite(grandchild)).toBe(true)

      // Give the grandchild's allocation time to actually land before sampling.
      await Bun.sleep(500)
      const leaderRow = await $`ps -o rss= -p ${leader.pid}`.quiet().text()
      const leaderOnlyBytes = Number.parseInt(leaderRow.trim(), 10) * 1024

      const grouped = await KernelMetrics.sampleAll("kernels", [leader.pid])
      const groupBytes = grouped.get(leader.pid)?.memory_bytes

      expect(groupBytes).toBeDefined()
      // The grandchild alone holds 64MB the leader never touches, so the
      // group total must clear the leader-only reading by a wide,
      // noise-proof margin — not merely exceed it by a stray byte.
      expect(groupBytes!).toBeGreaterThan(leaderOnlyBytes + 32 * 1024 * 1024)
    } finally {
      // Kill the whole process GROUP, not just the leader — notebook.ts
      // relies on exactly this (detached: true) so aborting a kernel reaps
      // everything it forked. A negative pid targets killpg(2) via the
      // group's own pgid, which equals the leader's pid here.
      try {
        process.kill(-leader.pid, "SIGKILL")
      } catch {
        // Already gone.
      }
      await leader.exited
      // The grandchild is reparented (to init or a subreaper) the instant the
      // leader dies, and its own SIGKILL lands at the same time via the
      // group signal — but the OS reaps that zombie asynchronously, so give
      // it a moment before asserting nothing survived.
      await Bun.sleep(300)
      // Confirm the reap actually worked: neither process should still be
      // visible to ps — nothing leaked out of the killed group.
      const survivors = await $`ps -o pid= -p ${leader.pid},${grandchild}`
        .quiet()
        .text()
        .catch(() => "")
      expect(survivors.trim()).toBe("")
    }
  })
})
