import { $ } from "bun"
import { beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import os from "node:os"
import { KernelMetrics } from "../../../src/science/kernel/metrics"

beforeEach(() => KernelMetrics.reset())

// Ground truth, parsed here rather than borrowed from the subject: a test that
// measured a group with the code under test could only ever confirm that code
// agrees with itself. USER_HZ is written out as the literal 100 for the same
// reason — the subject reads its divisor from the auxiliary vector, so a wrong
// reading there shows up as a wrong ratio here.
const fields = async (pid: number) => {
  const text = await Bun.file(`/proc/${pid}/stat`)
    .text()
    .catch(() => "")
  if (!text) return
  const rest = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)
  const values = [11, 12, 13, 14].map((index) => Number.parseInt(rest[index] ?? "", 10))
  if (values.some((value) => !Number.isFinite(value))) return
  return values
}

// Every process sharing a process group, straight from ps.
const members = async (pgid: number) => {
  const listing = await $`ps -Ao pid=,pgid=`
    .quiet()
    .text()
    .catch(() => "")
  return listing
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, group] = line.trim().split(/\s+/)
      return Number.parseInt(group ?? "", 10) === pgid ? [Number.parseInt(pid ?? "", 10)] : []
    })
}

// Cumulative processor seconds for a whole group, reaped descendants included.
const burn = async (pgid: number) => {
  const values = await Promise.all((await members(pgid)).map(fields))
  return values.reduce((sum, value) => sum + (value ?? []).reduce((part, tick) => part + tick, 0), 0) / 100
}

// Cumulative processor seconds ONE process burned itself — utime + stime, with
// no descendant time — so a test can prove the leader really was idle.
const own = async (pid: number) => {
  const value = await fields(pid)
  return ((value?.[0] ?? 0) + (value?.[1] ?? 0)) / 100
}

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

    expect(readings.get(4821)).toEqual({
      members: [{ pid: 4821, memory_bytes: 421_888_000 }],
      seconds: 12.484375,
      reaped: false,
      memory_bytes: 421_888_000,
    })
    expect(readings.get(4822)?.seconds).toBeCloseTo(0.15625, 6)
    // Get-Process reports a process's own time only, so a Windows reading can
    // never claim to have absorbed a reaped descendant's.
    expect(readings.get(4822)?.reaped).toBe(false)
  })

  test("sums a process and its reaped descendants from /proc/<pid>/stat", () => {
    // Real /proc/self/stat shape: pid, comm, state, ppid, pgrp, then the rest.
    // utime 120 + stime 45 + cutime 900 + cstime 30 = 1095 ticks.
    const stat =
      "4821 (python3) S 4820 4821 4821 0 -1 4194304 2530 73 0 0 120 45 900 30 20 0 12 0 6723531 75724177408 9594"

    expect(KernelMetrics.ticks(stat)).toBe(1_095)
  })

  test("reads /proc stat fields past an executable name containing spaces and parentheses", () => {
    // comm is bounded by parentheses but is NOT escaped, so a process really can
    // be named "foo (bar) baz". Splitting on the first ')' — or on whitespace —
    // slides every later field along and reports a process with millions of
    // seconds of CPU time.
    const stat = "4821 (foo (bar) baz) S 4820 4821 4821 0 -1 4194304 2530 73 0 0 120 45 900 30 20 0 12 0 6723531"

    expect(KernelMetrics.ticks(stat)).toBe(1_095)
  })

  test("reports nothing rather than a partial total for unreadable /proc stat text", () => {
    expect(KernelMetrics.ticks("")).toBeUndefined()
    expect(KernelMetrics.ticks("4821 (python3) S 4820 4821")).toBeUndefined()
    expect(KernelMetrics.ticks("no parenthesis here at all")).toBeUndefined()
  })

  test("reads the clock tick rate from the auxiliary vector rather than assuming one", () => {
    // /proc/self/auxv is (type, value) pairs of 64-bit words ending at type 0.
    // AT_CLKTCK is type 17 — the value glibc's own sysconf(_SC_CLK_TCK) returns.
    const auxv = (pairs: Array<[bigint, bigint]>) =>
      BigUint64Array.from(pairs.flatMap(([type, value]) => [type, value])).buffer as ArrayBuffer

    expect(
      KernelMetrics.hertz(
        auxv([
          [6n, 4_096n],
          [17n, 100n],
          [0n, 0n],
        ]),
      ),
    ).toBe(100)
    // A kernel built with a different USER_HZ must be honoured, not overridden.
    expect(KernelMetrics.hertz(auxv([[17n, 1_024n]]))).toBe(1_024)
    // No AT_CLKTCK entry, and a value no clock could have: both must decline so
    // the caller falls back to the documented 100 rather than dividing by junk.
    expect(
      KernelMetrics.hertz(
        auxv([
          [6n, 4_096n],
          [0n, 0n],
          [17n, 100n],
        ]),
      ),
    ).toBeUndefined()
    expect(KernelMetrics.hertz(auxv([[17n, 0n]]))).toBeUndefined()
    expect(KernelMetrics.hertz(auxv([[17n, 1n << 40n]]))).toBeUndefined()
    expect(KernelMetrics.hertz(new ArrayBuffer(0))).toBeUndefined()
  })

  test("agrees with this host's own sysconf(_SC_CLK_TCK)", async () => {
    if (process.platform !== "linux") return
    const auxv = await Bun.file("/proc/self/auxv").arrayBuffer()
    const reported = (await $`getconf CLK_TCK`.quiet().text()).trim()

    expect(KernelMetrics.hertz(auxv)).toBe(Number.parseInt(reported, 10))
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

  test("collects every row in a wanted group, summing cpu and memory and naming each member", () => {
    const readings = KernelMetrics.group(rows, [100, 200])

    // `ps -o time=` reports a process's own time only, so this sum loses a
    // member's whole lifetime the moment it is reaped: reaped is false, and
    // `derive` refuses to difference it across a group that lost a member.
    expect(readings.get(100)).toEqual({
      members: [
        { pid: 100, memory_bytes: 100_000 * 1024 },
        { pid: 101, memory_bytes: 50_000 * 1024 },
      ],
      seconds: 15,
      reaped: false,
      memory_bytes: 150_000 * 1024,
    })
    expect(readings.get(200)).toEqual({
      members: [
        { pid: 200, memory_bytes: 200_000 * 1024 },
        { pid: 201, memory_bytes: 80_000 * 1024 },
        { pid: 202, memory_bytes: 40_000 * 1024 },
      ],
      seconds: 105,
      reaped: false,
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
      members: [{ pid: 300 }, { pid: 301 }],
      seconds: 3,
      reaped: false,
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
  const mark = (seconds: number, at: number, members = [7]) => ({ seconds, members, at })
  // A Linux reading: the /proc total already absorbed every reaped descendant,
  // so a membership change cannot take work back out of it.
  const absorbed = (seconds: number, members = [7], extra: { memory_bytes?: number } = {}) => ({
    members: members.map((pid) => ({ pid })),
    seconds,
    reaped: true,
    ...extra,
  })
  // A macOS/Windows reading: `ps -o time=` and Get-Process report a process's
  // own time only, so nothing accumulates a reaped member's lifetime.
  const unabsorbed = (seconds: number, members = [7], extra: { memory_bytes?: number } = {}) => ({
    ...absorbed(seconds, members, extra),
    reaped: false,
  })

  test("derives percent of one core from a known cpu delta across a known window", () => {
    const sample = KernelMetrics.derive(mark(10, 1_000), absorbed(12.5, [7], { memory_bytes: 4_096 }), 6_000)

    expect(sample).toEqual({ cpu_percent: 50, memory_bytes: 4_096 })
  })

  test("reports past 100 for a group holding more than one core", () => {
    expect(KernelMetrics.derive(mark(4, 0), absorbed(10), 2_000)).toEqual({ cpu_percent: 300 })
  })

  test("reports an exact zero only when the group genuinely burned nothing", () => {
    expect(KernelMetrics.derive(mark(10, 1_000), absorbed(10), 3_500)).toEqual({ cpu_percent: 0 })
  })

  test("omits cpu entirely before a baseline exists, keeping the memory it did read", () => {
    expect(KernelMetrics.derive(undefined, absorbed(12.5, [7], { memory_bytes: 4_096 }), 6_000)).toEqual({
      memory_bytes: 4_096,
    })
  })

  test("omits cpu when the window never advanced or the counter went backwards", () => {
    expect(KernelMetrics.derive(mark(10, 6_000), absorbed(12.5), 6_000)).toEqual({})
    expect(KernelMetrics.derive(mark(10, 7_000), absorbed(12.5), 6_000)).toEqual({})
    // A total that lost work it had already counted is unmeasurable, not idle.
    expect(KernelMetrics.derive(mark(10, 1_000), absorbed(4), 6_000)).toEqual({})
  })

  test("omits cpu for a sub-second window but still reports memory, rather than fabricating a value across too short a gap", () => {
    // 500ms apart — two clients on the same scoped route polling milliseconds
    // after one another, the exact corruption a coarse cumulative counter
    // produces at that resolution.
    expect(KernelMetrics.derive(mark(10, 1_000), absorbed(10.4, [7], { memory_bytes: 4_096 }), 1_500)).toEqual({
      memory_bytes: 4_096,
    })
  })

  test("still derives a value at exactly a 1 second window, the inclusive floor", () => {
    expect(KernelMetrics.derive(mark(10, 1_000), absorbed(10.5), 2_000)).toEqual({ cpu_percent: 50 })
  })

  test("keeps a reaped worker's whole burn in the group's total instead of losing it", () => {
    // Two consecutive polls of one kernel's group. Between them the forked
    // worker (101) burned a full core for the whole 2s window and was reaped,
    // while the leader (100) sat blocked in waitpid and burned nothing at all.
    //
    // On Linux the worker's time did not leave with it: the kernel added it to
    // its parent's cutime, so the group total climbs 10 → 12. Any sampler that
    // can only see live processes reads 10 → 10 and reports a MEASURED zero for
    // a group that held a core the entire time — "0.0 cores" on the strip.
    expect(KernelMetrics.derive(mark(10, 1_000, [100, 101]), absorbed(12, [100]), 3_000)).toEqual({
      cpu_percent: 100,
    })
  })

  test("counts a member forked inside the window from its whole cumulative total", () => {
    // A worker that did not exist at the previous poll burned every second it
    // carries INSIDE this window, so its full total belongs to this window.
    // The leader added 1s and the new worker 2s across 2s of wall clock.
    expect(KernelMetrics.derive(mark(10, 1_000, [100]), absorbed(13, [100, 101]), 3_000)).toEqual({
      cpu_percent: 150,
    })
  })

  test("refuses a shrinking group's delta where nothing accumulates reaped time", () => {
    // macOS and Windows have no cutime equivalent, so a member that left took
    // its whole lifetime out of the sum. The remaining delta may still look
    // non-negative while understating the window by an unknown amount, so the
    // window is reported as unmeasurable rather than as an undercount dressed
    // up as a reading.
    expect(KernelMetrics.derive(mark(15, 1_000, [100, 101]), unabsorbed(17, [100]), 3_000)).toEqual({})
    // Nothing overlaps at all — Unavailable, not a zero invented from an empty
    // intersection.
    expect(KernelMetrics.derive(mark(10, 1_000, [100]), unabsorbed(4, [900]), 3_000)).toEqual({})
    // A member that only ARRIVED is safe even there: it was forked inside the
    // window, so every second it carries was burned inside the window.
    expect(KernelMetrics.derive(mark(10, 1_000, [100]), unabsorbed(13, [100, 101]), 3_000)).toEqual({
      cpu_percent: 150,
    })
  })

  test("refuses a mark older than the staleness bound rather than averaging across it", () => {
    // A mark this old belongs to a poller that stopped asking; the OS may have
    // recycled the pid onto an unrelated process by now, and even if it did
    // not, a minutes-wide average is not the live reading the strip claims.
    const previous = mark(10, 0)

    expect(
      KernelMetrics.derive(previous, absorbed(100, [7], { memory_bytes: 4_096 }), KernelMetrics.stale + 1),
    ).toEqual({
      memory_bytes: 4_096,
    })
    // The bound itself still measures.
    expect(KernelMetrics.derive(previous, absorbed(10), KernelMetrics.stale)).toEqual({ cpu_percent: 0 })
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

  test("reports a busy group's true load while an IDLE leader's workers do all the burning", async () => {
    if (process.platform !== "linux") return
    // The production shape, and the one every earlier sampler was blind to. The
    // group leader is the sandbox wrapper: it forks the interpreter once and
    // then sits blocked in waitpid, burning nothing for the whole run. The
    // interpreter is idle too — it forks a worker, blocks in waitpid, reaps it,
    // and forks another. Only the workers burn, and no worker lives long enough
    // to appear in two consecutive polls.
    //
    // So a sampler that can only difference processes present in BOTH samples
    // has nothing to difference: the two live members never move and the
    // workers never overlap, and it reports a MEASURED 0 while a full core is
    // held. A sampler that reads only the LEADER's reaped-descendant counters
    // is equally blind, because the interpreter — not the leader — is what
    // reaps the workers. Only summing utime+stime+cutime+cstime across every
    // live member sees this group at all.
    const script = [
      "import os, sys, time",
      "def spin(seconds):",
      "    end = time.time() + seconds",
      "    while time.time() < end:",
      "        pass",
      "mid = os.fork()",
      "if mid == 0:",
      "    while True:",
      "        kid = os.fork()",
      "        if kid == 0:",
      "            spin(2)",
      "            os._exit(0)",
      "        os.waitpid(kid, 0)",
      "sys.stdout.write('READY\\n')",
      "sys.stdout.flush()",
      "os.waitpid(mid, 0)",
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
      // group's real load. 2.5s is the interval the Compute strip actually
      // polls at, and it is longer than a worker's whole 2s lifetime.
      await KernelMetrics.sampleAll("kernels", [leader.pid])
      let previous = { group: await burn(leader.pid), leader: await own(leader.pid), at: Date.now() }
      const readings: Array<{ reported?: number; truth: number; leader: number }> = []
      for (let poll = 0; poll < 6; poll += 1) {
        await Bun.sleep(2_500)
        const reported = (await KernelMetrics.sampleAll("kernels", [leader.pid])).get(leader.pid)?.cpu_percent
        const current = { group: await burn(leader.pid), leader: await own(leader.pid), at: Date.now() }
        const elapsed = (current.at - previous.at) / 1_000
        readings.push({
          reported,
          truth: ((current.group - previous.group) / elapsed) * 100,
          leader: ((current.leader - previous.leader) / elapsed) * 100,
        })
        previous = current
      }

      for (const reading of readings) {
        // The group really is busy: ground truth read straight out of /proc,
        // independently of the subject, says close to one whole core.
        expect(reading.truth).toBeGreaterThan(50)
        // ...and the leader itself is genuinely idle, so nothing here can pass
        // on the leader's own burn the way a busy-waiting leader would.
        expect(reading.leader).toBeLessThan(reading.truth / 10)
        // Never absent, and never the fabricated 0 the strip renders as "0.0
        // cores" while a core is held.
        expect(typeof reading.reported).toBe("number")
        expect(reading.reported).toBeGreaterThan(0)
        // And close to the truth, not merely non-zero: within 20% either way of
        // an independently measured rate.
        expect(reading.reported! / reading.truth).toBeGreaterThan(0.8)
        expect(reading.reported! / reading.truth).toBeLessThan(1.2)
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
  }, 60_000)

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

  test("keeps reporting proportional memory for a group holding an unreaped zombie", async () => {
    if (process.platform === "win32") return
    if (!(await Bun.file(`/proc/${process.pid}/smaps_rollup`).exists())) {
      console.log("SKIPPED: /proc/<pid>/smaps_rollup is unavailable on this host, so PSS cannot be measured")
      return
    }
    // The same 200 MB leader and three copy-on-write children as above, plus one
    // child that exits and is never waited for. A zombie has no address space,
    // so its smaps_rollup stays unreadable for as long as it stays unreaped —
    // indefinitely, which is exactly what a routine using multiprocessing
    // leaves behind. Letting ANY unreadable member force the summed-RSS
    // fallback therefore restored the 4x overcount permanently. A zombie's RSS
    // is measurably 0, so it holds nothing and can be skipped without mixing
    // PSS and RSS in one figure.
    const script = [
      "import os, sys, time",
      "buf = bytearray(200 * 1024 * 1024)",
      "for offset in range(0, len(buf), 4096):",
      "    buf[offset] = 1",
      "for _ in range(3):",
      "    if os.fork() == 0:",
      "        time.sleep(30)",
      "        os._exit(0)",
      "if os.fork() == 0:",
      "    os._exit(0)",
      "time.sleep(0.5)",
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
      // Non-vacuous: a zombie really is in the group, and its rollup really is
      // unreadable. Without this the test would pass on a host that reaped it.
      // Listed host-wide and filtered on pgid, not selected with `ps -g`: GNU
      // ps reads -g as a SESSION selector, so it would silently answer a
      // different question here than on BSD.
      const states = await $`ps -Ao pid=,pgid=,stat=,rss=`
        .quiet()
        .text()
        .catch(() => "")
      const zombie = states
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .find((row) => Number.parseInt(row[1] ?? "", 10) === leader.pid && (row[2] ?? "").startsWith("Z"))
      expect(zombie).toBeDefined()
      expect(Number.parseInt(zombie![3] ?? "", 10)).toBe(0)
      expect(
        await Bun.file(`/proc/${zombie![0]}/smaps_rollup`)
          .text()
          .catch(() => undefined),
      ).toBeUndefined()

      const samples = await KernelMetrics.sampleAll("kernels", [leader.pid])
      const bytes = samples.get(leader.pid)?.memory_bytes

      expect(bytes).toBeDefined()
      // Same bound as the zombie-free case: the machine holds the 200 MB once,
      // plus four interpreters' own footprints. Falling back to summed RSS
      // because of the zombie reads near 800 MB.
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
