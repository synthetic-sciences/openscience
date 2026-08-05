import { $ } from "bun"

// Live resource usage for kernel processes. Every platform can cheaply report
// cumulative CPU seconds and resident bytes for a pid, so one algorithm covers
// all three: sample, keep the previous sample, derive load from the delta.
//
// `ps -o %cpu` is deliberately NOT used — the procps manual defines it as the
// average over a process's entire lifetime, which is wrong for a live meter.
//
// Platforms or processes that cannot report a value simply omit the field —
// the UI shows "Unavailable", never 0. A field that IS reported as 0 means the
// sampler measured exactly nothing, which an idle kernel genuinely does.
export namespace KernelMetrics {
  export interface Sample {
    cpu_percent?: number
    memory_bytes?: number
  }

  // One process inside a kernel's group, with the resident size `ps` reported
  // for it. The per-member resident figure is kept — rather than only the
  // group's sum — because a member whose PSS cannot be read but whose RSS is
  // measurably 0 holds nothing and can be skipped, while one with real RSS
  // cannot (see `proportional`).
  export interface Member {
    pid: number
    memory_bytes?: number
  }

  // One kernel's whole process group as of a single poll.
  //
  // `seconds` is the group's CUMULATIVE processor time, and `reaped` states
  // whether that total also accounts for descendants that have already exited
  // and been waited for. On Linux it does — /proc/<pid>/stat's `cutime`/`cstime`
  // hold the time of a process's reaped children, recursively — so the total is
  // monotonic across a membership change by construction: a worker that was
  // forked and reaped entirely inside one poll window has not vanished from the
  // sum, its time moved into its parent's counters.
  //
  // Where nothing accumulates reaped time (macOS `ps`, Windows `Get-Process`),
  // `reaped` is false and `derive` refuses any window a member left, because
  // that member's whole lifetime left the sum with it. An unmeasurable window is
  // reported as unmeasurable; it is never floored to 0.
  export interface Reading {
    members: Member[]
    seconds: number
    reaped: boolean
    memory_bytes?: number
  }

  export interface Mark {
    seconds: number
    members: number[]
    at: number
  }

  // One row of unix `ps` output: a single process tagged with the process
  // GROUP it belongs to. Kept separate from `Reading` because a kernel's
  // reading covers every row of its group (see `group`), not a single row.
  export interface Row {
    pid: number
    pgid: number
    cpu_seconds: number
    memory_bytes?: number
  }

  // How old a mark may be and still measure a window. Beyond this the entry is
  // dropped rather than used: a poller that stopped asking (a stopped kernel, a
  // hidden tab) leaves its mark behind, and the OS eventually recycles that pid
  // onto an unrelated process whose cumulative seconds would derive a small
  // fabricated percentage for work no kernel did. 30s is twelve missed 2.5s
  // polls — far beyond any live poller's cadence — and the same bound host.ts
  // uses to decide a rolling baseline is too old to average meaningfully.
  export const stale = 30_000

  // Processor seconds the group burned between two samples.
  //
  // A total that went BACKWARDS is refused: the counter lost work it had
  // already counted (a member reparented outside the group and reaped by init,
  // a stat unreadable this poll, a recycled pid). That is an unmeasurable
  // window, not an idle one.
  //
  // Without a reaped-descendant accumulator, a member LEAVING the group takes
  // its whole lifetime out of the sum, so a delta that still looks non-negative
  // may understate the window by an unknown amount — refused for the same
  // reason. A member that ARRIVED is safe either way: it was forked inside the
  // window, so every second it carries was burned inside the window.
  const burned = (previous: Mark, reading: Reading) => {
    if (reading.seconds < previous.seconds) return
    const members = new Set(reading.members.map((member) => member.pid))
    if (!reading.reaped && previous.members.some((pid) => !members.has(pid))) return
    return reading.seconds - previous.seconds
  }

  // The delta arithmetic on its own, so a known cpu delta across a known window
  // can be asserted exactly instead of against a wall clock. cpu_percent is
  // percent of ONE core, so a group pinning three cores reads 300. A window
  // that has not advanced, or one whose total cannot be compared, yields no
  // cpu_percent at all — never a 0 the UI would render as an idle kernel.
  //
  // A window under a second is floored to unmeasurable rather than trusted:
  // /proc counts in 10ms ticks and `ps -o time=` in whole seconds, so two
  // clients on the same scoped route polling milliseconds apart would otherwise
  // read either a fabricated 0 or a wild multiple. A window longer than `stale`
  // is refused for the reason given there.
  export function derive(previous: Mark | undefined, reading: Reading, at: number) {
    const elapsed = previous ? at - previous.at : 0
    const used = previous && elapsed >= 1_000 && elapsed <= stale ? burned(previous, reading) : undefined
    return {
      ...(used === undefined ? {} : { cpu_percent: (used / (elapsed / 1_000)) * 100 }),
      ...(reading.memory_bytes === undefined ? {} : { memory_bytes: reading.memory_bytes }),
    }
  }

  // ps prints cumulative processor time as [[dd-]hh:]mm:ss
  export function seconds(value: string) {
    const split = value.split("-")
    const days = split.length > 1 ? Number.parseInt(split[0] ?? "", 10) : 0
    const clock = (split.length > 1 ? split[1] : split[0]) ?? ""
    const parts = clock.split(":").map((part) => Number.parseInt(part, 10))
    if (!Number.isFinite(days) || parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return
    const [hours, minutes, rest] = parts.length === 3 ? parts : [0, parts[0], parts[1]]
    return days * 86_400 + (hours ?? 0) * 3_600 + (minutes ?? 0) * 60 + (rest ?? 0)
  }

  // Cumulative processor TICKS for a process AND every descendant it has
  // already waited for: /proc/<pid>/stat fields `utime`, `stime`, `cutime`,
  // `cstime`. The `c*` pair is the whole point — when a child is reaped its
  // accumulated time does not disappear, the kernel adds it to the parent's
  // `cutime`/`cstime` (recursively, so a grandchild's time reaches the parent
  // through the child it was reaped by). A worker that was forked, burned a
  // core and was reaped entirely between two polls is therefore still counted.
  //
  // Field 2 is `comm`, the executable name in parentheses, and it may itself
  // contain spaces and parentheses — a process really can be named `foo (bar)`.
  // Splitting after the LAST ')' is the only parse that survives that; the
  // remaining fields start at `state` (field 3), so `utime` (field 14) is index
  // 11, `stime` 12, `cutime` 13, `cstime` 14.
  export function ticks(text: string) {
    const close = text.lastIndexOf(")")
    if (close < 0) return
    const fields = text
      .slice(close + 1)
      .trim()
      .split(/\s+/)
    const values = [11, 12, 13, 14].map((index) => Number.parseInt(fields[index] ?? "", 10))
    if (values.some((value) => !Number.isFinite(value))) return
    return values.reduce((sum, value) => sum + value, 0)
  }

  // The tick rate those counters are expressed in — `sysconf(_SC_CLK_TCK)`.
  // glibc answers that call from the AT_CLKTCK entry of the auxiliary vector,
  // which /proc/self/auxv exposes verbatim as an array of (type, value) pairs
  // of `unsigned long`, terminated by a zero type. Reading it is a file read,
  // not a spawn and not an FFI call, so the divisor is measured rather than
  // assumed.
  //
  // The parse assumes 64-bit little-endian words, which is every target Bun
  // ships for. A different layout parses as nonsense rather than silently
  // wrong values, so implausible readings are rejected and the caller falls
  // back to 100 — the value on every architecture in that set, and on every
  // Linux architecture except alpha and ia64.
  export function hertz(auxv: ArrayBuffer) {
    const usable = auxv.byteLength - (auxv.byteLength % 8)
    const words = new BigUint64Array(auxv.slice(0, usable))
    for (const [index, word] of words.entries()) {
      if (index % 2 === 1) continue
      if (word === 0n) return
      if (word !== 17n) continue
      const value = Number(words[index + 1] ?? 0n)
      if (value > 0 && value <= 1_000_000) return value
      return
    }
    return
  }

  export function unix(text: string) {
    const rows: Row[] = []
    for (const line of text.trim().split("\n")) {
      const [id, gid, time, rss] = line.trim().split(/\s+/)
      const pid = Number.parseInt(id ?? "", 10)
      const pgid = Number.parseInt(gid ?? "", 10)
      const cpu = seconds(time ?? "")
      const resident = Number.parseInt(rss ?? "", 10)
      if (!Number.isFinite(pid) || !Number.isFinite(pgid) || cpu === undefined) continue
      rows.push({
        pid,
        pgid,
        cpu_seconds: cpu,
        ...(Number.isFinite(resident) ? { memory_bytes: resident * 1024 } : {}),
      })
    }
    return rows
  }

  // Folds every row belonging to a wanted process group into ONE Reading —
  // the kernel leader plus every descendant it forked (the Python
  // interpreter, plus any joblib/BLAS/multiprocessing workers), which all
  // share its pgid because notebook.ts spawns the kernel with detached: true
  // (setsid) specifically to make it its own process-group leader. A row
  // whose pgid nobody asked about is dropped, so unrelated groups never
  // bleed into each other's reading — pure and spawn-free, so it is testable
  // against fixture rows alone.
  //
  // `reaped` is false here: `ps -o time=` reports a process's own time only, so
  // this sum loses a member's whole lifetime the moment it is reaped. On Linux
  // `read` replaces `seconds` with the /proc total, which does not (see
  // `absorbed`); macOS has no equivalent and keeps this figure, which `derive`
  // then refuses to difference across a shrinking group.
  //
  // Memory IS summed here, which double-counts pages shared between members;
  // `read` replaces it with the proportional figure where the kernel can
  // report one (see `proportional`).
  export function group(rows: Row[], pgids: Iterable<number>) {
    const wanted = new Set(pgids)
    const readings = new Map<number, Reading>()
    for (const row of rows) {
      if (!wanted.has(row.pgid)) continue
      const current = readings.get(row.pgid) ?? { members: [], seconds: 0, reaped: false }
      readings.set(row.pgid, {
        members: [
          ...current.members,
          { pid: row.pid, ...(row.memory_bytes === undefined ? {} : { memory_bytes: row.memory_bytes }) },
        ],
        seconds: current.seconds + row.cpu_seconds,
        reaped: false,
        ...(current.memory_bytes === undefined && row.memory_bytes === undefined
          ? {}
          : { memory_bytes: (current.memory_bytes ?? 0) + (row.memory_bytes ?? 0) }),
      })
    }
    return readings
  }

  export function windows(text: string) {
    const readings = new Map<number, Reading>()
    for (const line of text.trim().split(/\r?\n/)) {
      // Split on a single space, NOT /\s+/. When $_.CPU is $null the
      // interpolation emits "4821  421888000" — collapsing runs of whitespace
      // would slide WorkingSet64 into the CPU column and report a process with
      // 421888000 seconds of CPU time.
      const [id, cpu, ws] = line.trim().split(" ")
      const pid = Number.parseInt(id ?? "", 10)
      const used = Number.parseFloat(cpu ?? "")
      const resident = Number.parseInt(ws ?? "", 10)
      if (!Number.isFinite(pid) || !Number.isFinite(used)) continue
      const bytes = Number.isFinite(resident) ? { memory_bytes: resident } : {}
      readings.set(pid, { members: [{ pid, ...bytes }], seconds: used, reaped: false, ...bytes })
    }
    return readings
  }

  // Proportional set size from /proc/<pid>/smaps_rollup, in bytes. PSS divides
  // every shared page by the number of processes mapping it, so a forked
  // worker's copy-on-write share of its parent's heap is counted once across
  // the group instead of once per member — exactly the "how much of this
  // machine do my kernels hold" question the strip asks. smaps_rollup is the
  // kernel's own whole-process rollup, far cheaper than parsing smaps.
  export function pss(text: string) {
    const match = text.match(/^Pss:\s+(\d+)\s+kB$/m)
    if (!match) return
    const value = Number.parseInt(match[1] ?? "", 10)
    if (!Number.isFinite(value)) return
    return value * 1024
  }

  // The group's proportional footprint, or nothing if a member that actually
  // holds pages cannot be read — mixing PSS for some members with RSS for
  // others would report a figure that is neither. Nothing here means the caller
  // keeps the summed RSS, which OVERCOUNTS every page shared between members (a
  // 300 MB leader plus three forked children reads as roughly 1.2 GB). That
  // overcount is the deliberate fallback for hosts without smaps_rollup —
  // macOS, kernels before 4.14, or a process this user may not inspect —
  // because a wrong-but-real number beats omitting a figure the machine
  // genuinely holds.
  //
  // A member whose rollup is unreadable but whose resident size is measurably
  // ZERO is skipped instead of triggering that fallback. A zombie has no
  // address space, so its rollup is unreadable for as long as it stays unreaped
  // — indefinitely, for a routine that leaves one behind — and letting it force
  // the fallback silently restored the 4x overcount for the whole group. Zero
  // is zero in PSS and in RSS alike, so dropping a member that measurably holds
  // nothing mixes no units. Only a measured 0 qualifies: a member whose
  // resident size ps could not report might hold anything, and still falls back.
  const proportional = async (members: Member[]) => {
    const values = await Promise.all(
      members.map(async (member) => ({
        member,
        bytes: await Bun.file(`/proc/${member.pid}/smaps_rollup`)
          .text()
          .then(pss)
          .catch(() => undefined),
      })),
    )
    const bytes: number[] = []
    for (const value of values) {
      if (value.bytes !== undefined) bytes.push(value.bytes)
      if (value.bytes === undefined && value.member.memory_bytes !== 0) return
    }
    if (!bytes.length) return
    return bytes.reduce((sum, value) => sum + value, 0)
  }

  const stat = (pid: number) =>
    Bun.file(`/proc/${pid}/stat`)
      .text()
      .then(ticks)
      .catch(() => undefined)

  // Replaces the `ps`-derived sum with the /proc total for the same members:
  // monotonic across reaping, and quantised to 10ms ticks rather than `ps -o
  // time=`'s whole seconds. The resolution matters as much as the monotonicity
  // — a whole second over a 2.5s poll is 0.4 cores, so everything below that
  // read as an exact 0; ticks put the floor near 0.004 cores.
  //
  // Every live member contributes its own time AND its reaped descendants', not
  // just the leader's. There is no double counting: a process's `cutime` only
  // ever holds the time of processes that have terminated and been waited for,
  // which are by definition absent from the live member list, and a terminated
  // process was waited for exactly once. Counting only the leader would instead
  // hide every worker an intermediate member reaped until that member itself
  // died — the production shape exactly, where the group leader is the sandbox
  // wrapper and the Python interpreter that reaps the workers is its child.
  //
  // If no member's stat could be read the `ps` figure stands; that group is
  // about to drop out of the poll entirely.
  const absorbed = async (reading: Reading, rate: number) => {
    const values = await Promise.all(reading.members.map((member) => stat(member.pid)))
    const read = values.flatMap((value) => (value === undefined ? [] : [value]))
    if (!read.length) return reading
    return { ...reading, seconds: read.reduce((sum, value) => sum + value, 0) / rate, reaped: true }
  }

  let rate: number | undefined

  const clock = async () => {
    rate ??=
      (await Bun.file("/proc/self/auxv")
        .arrayBuffer()
        .then(hertz)
        .catch(() => undefined)) ?? 100
    return rate
  }

  // Plain space-separated lines, so Windows and unix share one output shape.
  // ConvertTo-Json is avoided: Windows PowerShell 5.1 emits a bare object for a
  // single process and an array for many, and has no -AsArray to force it.
  const script = (pids: number[]) =>
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.CPU) $($_.WorkingSet64)" }`

  const read = async (pids: number[]) => {
    if (process.platform === "win32") {
      // Windows Get-Process has no cheap way to enumerate a process's
      // descendants (no pgid concept), so this stays a straight per-pid
      // sample of the sandbox wrapper only — the same undercount the
      // Linux/macOS path had before this fix. Walking each kernel's child
      // tree via Win32_Process.ParentProcessId is a separate job; nobody can
      // test it in this environment.
      const output = await $`powershell -NoProfile -NonInteractive -Command ${script(pids)}`
        .quiet()
        .text()
        .catch(() => "")
      return windows(output)
    }
    if (process.platform !== "darwin" && process.platform !== "linux") return new Map<number, Reading>()
    // One spawn samples EVERY process on the host, tagged with its group,
    // rather than the pids we asked about — there is no portable, reliably
    // pgid-scoped `ps` selector across GNU (Linux) and BSD (macOS) ps: GNU
    // ps's own `-g` selects by session, not process group (verified against
    // this host's procps-ng — a distinct pgid within the same session comes
    // back empty). Filtering the full listing down to the wanted pgids in
    // `group()` sidesteps that ambiguity entirely while keeping exactly one
    // spawn per poll, same as before.
    const output = await $`ps -Ao pid=,pgid=,time=,rss=`
      .quiet()
      .text()
      .catch(() => "")
    const readings = group(unix(output), pids)
    // /proc reads, not spawns — still one spawn per poll. macOS has neither
    // smaps_rollup nor a reaped-descendant counter, so it keeps the summed RSS
    // and the summed `ps` seconds; `derive` refuses to difference the latter
    // across a group that lost a member rather than reporting an undercount as
    // if it were a measurement.
    if (process.platform !== "linux") return readings
    const ticked = await clock()
    const resolved = new Map<number, Reading>()
    for (const [pgid, reading] of readings) {
      const counted = await absorbed(reading, ticked)
      const bytes = await proportional(reading.members)
      resolved.set(pgid, bytes === undefined ? counted : { ...counted, memory_bytes: bytes })
    }
    return resolved
  }

  // Keyed by caller scope AND pid. Independent pollers watch the same pids on
  // their own cadence — the Compute strip polls /notebook/compute while the
  // Kernels panel polls /notebook/kernels, and two browser tabs each poll the
  // strip's route on their own offset — and a shared per-pid entry would make
  // each poll measure the gap to the OTHER caller's poll. Interleaved by
  // milliseconds that gap falls under the one-second floor, so whichever caller
  // polls first takes the window and the others are refused indefinitely.
  const baseline = new Map<string, Mark>()

  const key = (scope: string, pid: number) => `${scope}:${pid}`

  export function reset() {
    baseline.clear()
  }

  // The scoped keys currently held. A leaked baseline is invisible in a sample
  // map, yet it would derive a percentage for a pid the OS later recycles.
  export function tracked() {
    return [...baseline.keys()]
  }

  // Drops every mark older than `stale`, whoever owns it. Death-eviction below
  // only reaches pids the caller named, and a stopped kernel drops out of the
  // route's pid list entirely — nobody ever names it again, so without an age
  // sweep its entry lives as long as the process does. The same sweep bounds
  // per-client scopes: a closed browser tab stops polling and its whole scope
  // ages out. Scoped entries belonging to a live poller are refreshed every
  // 2.5s, so the sweep can never take one out from under an active surface the
  // way an unscoped prune would.
  const evict = (now: number) => {
    for (const [id, mark] of baseline) if (now - mark.at > stale) baseline.delete(id)
  }

  export async function sampleAll(scope: string, pids: number[]) {
    const samples = new Map<number, Sample>()
    // Before the early return, so a route that has stopped every kernel — and
    // therefore asks about no pids at all — still clears what it left behind.
    evict(Date.now())
    if (!pids.length) return samples
    const readings = await read(pids)
    const at = Date.now()
    for (const [pid, reading] of readings) {
      const previous = baseline.get(key(scope, pid))
      baseline.set(key(scope, pid), {
        seconds: reading.seconds,
        members: reading.members.map((member) => member.pid),
        at,
      })
      samples.set(pid, derive(previous, reading, at))
    }
    // Prune only pids THIS call asked about. Iterating the whole baseline would
    // drop entries belonging to other sessions — /notebook/kernels is polled
    // per-session, so two tabs on different sessions would wipe each other's
    // baselines every poll and pin cpu_percent at Unavailable forever.
    for (const pid of pids) if (!readings.has(pid)) baseline.delete(key(scope, pid))
    return samples
  }
}
