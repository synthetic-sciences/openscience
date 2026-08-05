import { $ } from "bun"
import { beforeEach, describe, expect, setSystemTime, test } from "bun:test"
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

    expect(readings.get(4821)).toEqual({ cpu: new Map([[4821, 12.484375]]), memory_bytes: 421_888_000 })
    expect(readings.get(4822)?.cpu.get(4822)).toBeCloseTo(0.15625, 6)
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

  test("collects every row in a wanted group, keeping cpu per member and summing memory", () => {
    const readings = KernelMetrics.group(rows, [100, 200])

    // CPU stays per-pid: summing cumulative counters across the group would
    // lose a reaped member's whole lifetime out of the next delta.
    expect(readings.get(100)).toEqual({
      cpu: new Map([
        [100, 10],
        [101, 5],
      ]),
      memory_bytes: 150_000 * 1024,
    })
    expect(readings.get(200)).toEqual({
      cpu: new Map([
        [200, 60],
        [201, 30],
        [202, 15],
      ]),
      memory_bytes: 320_000 * 1024,
    })
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

    expect(readings.get(300)).toEqual({
      cpu: new Map([
        [300, 1],
        [301, 2],
      ]),
    })
  })

  test("reads a group's proportional footprint from smaps_rollup, never a partial number", () => {
    const rollup = [
      "55d1c0a00000-7ffd0c1f2000 ---p 00000000 00:00 0 [rollup]",
      "Rss:              412000 kB",
      "Pss:              301224 kB",
      "Pss_Dirty:        298112 kB",
      "Shared_Clean:     110776 kB",
    ].join("\n")

    expect(KernelMetrics.pss(rollup)).toBe(301_224 * 1024)
    expect(KernelMetrics.pss("Rss: 412000 kB\n")).toBeUndefined()
    expect(KernelMetrics.pss("")).toBeUndefined()
    expect(KernelMetrics.pss("Pss: not-a-number kB\n")).toBeUndefined()
  })
})

describe("kernel metrics delta arithmetic", () => {
  const mark = (cpu: Map<number, number>, at: number) => ({ cpu, at })
  const one = (seconds: number) => new Map([[7, seconds]])

  test("derives percent of one core from a known cpu delta across a known window", () => {
    const sample = KernelMetrics.derive(mark(one(10), 1_000), { cpu: one(12.5), memory_bytes: 4_096 }, 6_000)

    expect(sample).toEqual({ cpu_percent: 50, memory_bytes: 4_096 })
  })

  test("reports past 100 for a process holding more than one core", () => {
    expect(KernelMetrics.derive(mark(one(4), 0), { cpu: one(10) }, 2_000)).toEqual({ cpu_percent: 300 })
  })

  test("reports an exact zero only when the process genuinely burned nothing", () => {
    expect(KernelMetrics.derive(mark(one(10), 1_000), { cpu: one(10) }, 3_500)).toEqual({ cpu_percent: 0 })
  })

  test("omits cpu entirely before a baseline exists, keeping the memory it did read", () => {
    expect(KernelMetrics.derive(undefined, { cpu: one(12.5), memory_bytes: 4_096 }, 6_000)).toEqual({
      memory_bytes: 4_096,
    })
  })

  test("omits cpu when the window never advanced or the counter went backwards", () => {
    expect(KernelMetrics.derive(mark(one(10), 6_000), { cpu: one(12.5) }, 6_000)).toEqual({})
    expect(KernelMetrics.derive(mark(one(10), 7_000), { cpu: one(12.5) }, 6_000)).toEqual({})
    expect(KernelMetrics.derive(mark(one(10), 1_000), { cpu: one(4) }, 6_000)).toEqual({})
  })

  test("omits cpu for a sub-second window but still reports memory, rather than fabricating a value across too short a gap", () => {
    // 500ms apart — two clients on the same scoped route polling milliseconds
    // after one another, the exact corruption `ps -o time=`'s whole-second
    // resolution produces.
    expect(KernelMetrics.derive(mark(one(10), 1_000), { cpu: one(10.4), memory_bytes: 4_096 }, 1_500)).toEqual({
      memory_bytes: 4_096,
    })
  })

  test("still derives a value at exactly a 1 second window, the inclusive floor", () => {
    expect(KernelMetrics.derive(mark(one(10), 1_000), { cpu: one(10.5) }, 2_000)).toEqual({ cpu_percent: 50 })
  })

  test("never lets a reaped worker cancel out the work the rest of the group did", () => {
    // Two consecutive polls of one kernel's group, shaped exactly like the ps
    // listing `read` parses. Between them the forked worker (101) finished and
    // was reaped, and the interpreter forked a fresh one (102) that inherited
    // no history but has already burned 3s of its own.
    //
    // Summing the group's CUMULATIVE seconds reads 15 then 15 — a MEASURED
    // zero for a leader that spent the whole 2s window pegging a core, which
    // the strip renders as "0.0 cores". Summing per-member deltas over the pids
    // present in both samples reads the leader's real 2s.
    const first = KernelMetrics.group(KernelMetrics.unix("100 100 0:10 100000\n101 100 0:05 50000\n"), [100])
    const second = KernelMetrics.group(KernelMetrics.unix("100 100 0:12 100000\n102 100 0:03 50000\n"), [100])
    const previous = first.get(100)
    const reading = second.get(100)

    expect(previous).toBeDefined()
    expect(reading).toBeDefined()
    expect(KernelMetrics.derive({ cpu: previous!.cpu, at: 1_000 }, reading!, 3_000)).toEqual({
      cpu_percent: 100,
      memory_bytes: 150_000 * 1024,
    })
  })

  test("counts a member that appeared since the last poll only from the poll it appeared in", () => {
    // The worker's 5 cumulative seconds were burned before this window opened,
    // so crediting them to it would spike the meter to 300%. Only the leader's
    // 1s delta is measurable.
    const previous = { cpu: new Map([[100, 10]]), at: 1_000 }
    const reading = {
      cpu: new Map([
        [100, 11],
        [101, 5],
      ]),
    }

    expect(KernelMetrics.derive(previous, reading, 3_000)).toEqual({ cpu_percent: 50 })
  })

  test("omits cpu when no member of the group survived from the previous sample", () => {
    // Nothing overlaps, so there is no process whose progress could be
    // measured — Unavailable, not a zero invented from an empty sum.
    expect(KernelMetrics.derive({ cpu: new Map([[100, 10]]), at: 1_000 }, { cpu: new Map([[900, 4]]) }, 3_000)).toEqual(
      {},
    )
  })

  test("refuses a mark older than the staleness bound rather than averaging across it", () => {
    // A mark this old belongs to a poller that stopped asking; the OS may have
    // recycled the pid onto an unrelated process by now, and even if it did
    // not, a minutes-wide average is not the live reading the strip claims.
    const previous = { cpu: new Map([[7, 10]]), at: 0 }

    expect(
      KernelMetrics.derive(previous, { cpu: new Map([[7, 100]]), memory_bytes: 4_096 }, KernelMetrics.stale + 1),
    ).toEqual({
      memory_bytes: 4_096,
    })
    // The bound itself still measures.
    expect(KernelMetrics.derive(previous, { cpu: new Map([[7, 10]]) }, KernelMetrics.stale)).toEqual({ cpu_percent: 0 })
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

  test("keeps reporting cpu for a group that forks and reaps workers while it stays busy", async () => {
    if (process.platform === "win32") return
    // The fork-heavy shape every real kernel produces: a multiprocessing or
    // joblib pool, `subprocess.run` in a loop, a shell cell. The leader pegs a
    // core throughout while a pool of four workers is forked, burns processor
    // time, is reaped, and is forked again — so the group is never idle and
    // most poll windows straddle a whole batch's reaping.
    //
    // Summing the group's CUMULATIVE seconds loses every reaped worker's
    // accumulated total at once, so the next delta reads zero (rendered "0.0
    // cores") or negative (rendered "Unavailable") while five processes are
    // visibly pegging five cores. Per-member deltas cannot: every term is one
    // process's own non-negative progress.
    const script = [
      "import os, sys, time",
      "def spin(seconds):",
      "    end = time.time() + seconds",
      "    while time.time() < end:",
      "        pass",
      "sys.stdout.write('READY\\n')",
      "sys.stdout.flush()",
      "while True:",
      "    kids = []",
      "    for _ in range(4):",
      "        child = os.fork()",
      "        if child == 0:",
      "            spin(2)",
      "            os._exit(0)",
      "        kids.append(child)",
      "    for kid in kids:",
      "        while os.waitpid(kid, os.WNOHANG)[0] == 0:",
      "            spin(0.05)",
    ].join("\n")
    const leader = Bun.spawn(["python3", "-c", script], { detached: true, stdout: "pipe", stderr: "ignore" })
    const reader = leader.stdout.getReader()
    const decoder = new TextDecoder()
    let announced = ""
    while (!announced.includes("READY")) {
      const { value, done } = await reader.read()
      if (done) break
      announced += decoder.decode(value)
    }

    try {
      expect(announced).toContain("READY")
      // First poll establishes the baseline; every later one must read the
      // group's real load. 1.5s windows clear derive()'s 1s floor with room for
      // `ps -o time=`'s whole-second quantisation.
      await KernelMetrics.sampleAll("kernels", [leader.pid])
      const readings: Array<number | undefined> = []
      for (let poll = 0; poll < 8; poll += 1) {
        await Bun.sleep(1_500)
        readings.push((await KernelMetrics.sampleAll("kernels", [leader.pid])).get(leader.pid)?.cpu_percent)
      }

      // The leader alone holds a core across every window, so the floor is one
      // whole quantised second over ~1.5s of wall clock — around 65%. 10 is far
      // below anything a scheduler hiccup could produce and far above the 0 (or
      // absent) reading the defect emits.
      for (const value of readings) {
        expect(typeof value).toBe("number")
        expect(value).toBeGreaterThan(10)
      }
    } finally {
      try {
        process.kill(-leader.pid, "SIGKILL")
      } catch {
        // Already gone.
      }
      await leader.exited
      await Bun.sleep(300)
    }
  }, 40_000)

  test("reports a forked group's proportional memory rather than its shared pages once per member", async () => {
    if (process.platform === "win32") return
    if (!(await Bun.file(`/proc/${process.pid}/smaps_rollup`).exists())) {
      // Explicit rather than silent: on macOS and pre-4.14 Linux there is no
      // smaps_rollup, the sampler falls back to the summed RSS by design, and
      // asserting a proportional figure here would assert something false.
      console.log("SKIPPED: /proc/<pid>/smaps_rollup is unavailable on this host, so PSS cannot be measured")
      return
    }
    // A leader that touches a known 200 MB and then forks three idle children.
    // The children map the very same pages copy-on-write, so summing RSS counts
    // that 200 MB four times — the 4.03x overcount that can exceed the host's
    // total memory and silently peg the strip's meter.
    const script = [
      "import os, sys, time",
      "buf = bytearray(200 * 1024 * 1024)",
      "for offset in range(0, len(buf), 4096):",
      "    buf[offset] = 1",
      "for _ in range(3):",
      "    if os.fork() == 0:",
      "        time.sleep(30)",
      "        os._exit(0)",
      "sys.stdout.write('READY\\n')",
      "sys.stdout.flush()",
      "time.sleep(30)",
    ].join("\n")
    const leader = Bun.spawn(["python3", "-c", script], { detached: true, stdout: "pipe", stderr: "ignore" })
    const reader = leader.stdout.getReader()
    const decoder = new TextDecoder()
    let announced = ""
    while (!announced.includes("READY")) {
      const { value, done } = await reader.read()
      if (done) break
      announced += decoder.decode(value)
    }

    try {
      expect(announced).toContain("READY")
      const samples = await KernelMetrics.sampleAll("kernels", [leader.pid])
      const bytes = samples.get(leader.pid)?.memory_bytes

      expect(bytes).toBeDefined()
      // The machine really holds the 200 MB once, plus four interpreters'
      // own footprints. Anything near 800 MB is the same pages counted per
      // process.
      expect(bytes!).toBeGreaterThan(150 * 1024 * 1024)
      expect(bytes!).toBeLessThan(350 * 1024 * 1024)
    } finally {
      try {
        process.kill(-leader.pid, "SIGKILL")
      } catch {
        // Already gone.
      }
      await leader.exited
      await Bun.sleep(300)
    }
  }, 30_000)

  test("evicts a mark no later poll will ever name again", async () => {
    if (process.platform === "win32") return
    const kernel = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" })
    try {
      await KernelMetrics.sampleAll("kernels", [kernel.pid])

      expect(KernelMetrics.tracked().length).toBe(1)

      // The kernel is stopped, so the route stops passing its pid — and
      // death-eviction only reaches pids the call named. A mark this fresh must
      // survive: the poller may simply be between kernels.
      await KernelMetrics.sampleAll("kernels", [])

      expect(KernelMetrics.tracked().length).toBe(1)

      // One staleness bound later, the next poll of ANY scope sweeps it — the
      // clock moves rather than the test waiting 30s, and the mark itself is
      // untouched. A pid the OS recycles onto an unrelated process then starts
      // cold: Unavailable for one poll rather than a percentage derived from a
      // stranger's cumulative seconds.
      setSystemTime(new Date(Date.now() + KernelMetrics.stale + 1_000))
      await KernelMetrics.sampleAll("kernels", [])

      expect(KernelMetrics.tracked()).toEqual([])
    } finally {
      setSystemTime()
      kernel.kill()
      await kernel.exited
    }
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
