# Compute host strip — design

Status: approved, ready for implementation planning
Date: 2026-08-04
Branch: `openscience-ui-revamp`

## Problem

The Compute right-pane tab reports only what the _current session_ owns. `KernelPanel` renders
`0 live · 0 running · 0 queued` and a card per session kernel; the card shows `CPU`, `MEMORY`, `GPU`, `VRAM`
per kernel. Nothing on the surface answers the question a researcher actually asks before starting a run:
**does this machine have room?**

Free RAM, core count and current utilisation are absent, so the operator has to leave the app for `htop` to
decide whether to launch work. The kernel-attributed share of the machine is likewise invisible — the panel
can say a kernel uses 1.2 GB but not that the host has 9.3 GB left.

This spec adds a host-level strip above the Compute sub-tabs and closes the platform gap in per-process
sampling.

## Reference

The target visual comes from a screenshot of a separate prototype, not from this repo. Confirmed absent from
this codebase and every branch: a history-wide `-S` search for `cores busy` and `free of` returns nothing in
`frontend/`. The string `No live kernels` exists only on `aayam/kernel-science-workbench` at `645f3091`
(replaced by `3716c6a1`), in an inline-styled `KernelPanel` with no host metrics behind it. This is new work,
not a cherry-pick.

## Scope decisions

| Decision            | Choice                                                     | Consequence                                           |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| Metric scope        | Machine-wide header, session-scoped card list              | Strip is context; the list stays what you act on      |
| Placement           | Above the Kernels/Jobs tablist                             | Host capacity stays visible in both sub-views         |
| Metric source       | Platform agnostic, best source per OS behind one interface | Works on Linux, macOS, Windows; no caller branches    |
| Per-kernel sampling | Extend to Windows                                          | `ps` path stays for Linux/macOS; adds a third sampler |

Explicitly out of scope: GPU/VRAM host totals (the reference has no such tile), replacing the Kernels/Jobs
tabs, and any change to `ComputeJobs`.

## Architecture

### `backend/cli/src/science/kernel/host.ts` (new)

Machine facts only. Knows nothing about kernels, sessions or projects, so it can be tested standalone.

```ts
KernelHost.snapshot(): {
  memory: { total: number; available: number }
  cpu: { cores: number; busy: number } // busy is fractional cores, e.g. 2.1
}
```

**Memory.** `total` is `os.totalmem()` on every platform. `available` is `os.freemem()`, overridden by
`/proc/meminfo` `MemAvailable` when that file is readable. The override matters: on Linux `os.freemem()`
reports `MemFree`, which excludes reclaimable page cache, so a healthy 16 GB desktop reads as ~1.4 GB free.
macOS and Windows already report available-like values, so they take the `os.freemem()` path unchanged. One
interface, one refinement, no failure mode — if `/proc/meminfo` is missing or malformed the universal path
stands.

**CPU.** `cores` is `os.cpus().length`. `busy` is computed from the delta of per-core `{user, nice, sys, idle,
irq}` times between two `os.cpus()` reads. `os.cpus()` returns these times on all three platforms, unlike
`os.loadavg()`, which returns `[0, 0, 0]` on Windows.

Sampling is a module-level rolling baseline: each call diffs against the previous stored sample and then
stores the current one, so a 2.5 s poll costs nothing extra. A cold call with no baseline — or a baseline
older than 30 s, where the average would be meaningless — takes one inline 200 ms sample instead.

`busy` carries the same **one-second minimum window** as `KernelMetrics.derive`, for the same reason:
`os.cpus()` counts in 10 ms jiffies, so two concurrent requests measure a span in which at most one core has
ticked once — landing on idle that reads `busy: 0` on a host running at three cores, landing on user/sys it
reads every core pegged. Measured over 120 concurrent polls with a core deliberately held: 27 fabricated
zeros and 5 fully-pegged readings. A window under a second is refused and `busy` is **omitted**; the baseline
retention rule already covers it, keeping the older mark so the next call spans something real. The cold
path keeps its own 200 ms window — it takes both marks itself, so no concurrent caller can truncate it, and
blocking the first paint for a full second buys precision nobody asked for.

### `GET /notebook/compute` (new route)

Machine-wide, takes no `sessionID`. Distinct from `GET /notebook/kernels`, which stays session-scoped: the
strip and the list answer different questions and poll independently.

```json
{
  "memory": { "total": 16318000000, "available": 9300000000, "kernels": 0 },
  "cpu": { "cores": 8, "busy": 2.1, "kernels": 0.0 },
  "kernels": { "live": 0, "running": 0 }
}
```

`memory.kernels` and `cpu.kernels` aggregate every live kernel this server owns — `KernelRuntime.list()` with
no session filter, each entry sampled through `KernelMetrics`. A true zero and an unmeasurable figure are
different things and must not be conflated: when there are **no live kernels at all**, the kernel-attributed
share is knowably zero — that is a measurement, and both fields are sent as `0`. Both are **optional** only in
the other case — **live kernels exist but this poll could not sample them** (platform limitation, no baseline
yet, a sub-second window) — where the figure is genuinely unknown and the field is omitted, never fabricated
as `0`. This refines the existing contract in `notebook/runtime.ts`: _absent fields mean the platform could
not report them — render "Unavailable"; a field that is present and `0` means the platform measured exactly
that._

No registry change is needed. `KernelRuntime.list(sessionID?)` already exists (`registry.ts:550`), and
`GET /notebook/kernels` with no `sessionID` already enumerates every session and samples each kernel — the
new route reuses that same enumeration and reduces it to two numbers instead of shipping the full array to
the strip.

### `metrics.ts` — one algorithm, three commands

`KernelMetrics.sample(pid)` currently returns `{}` outside Linux/macOS, and its Linux/macOS numbers are wrong
for a live meter (see "Existing defect" below).

Both problems have the same fix. Every platform can cheaply report **cumulative CPU seconds** and **resident
bytes** for a PID. Sample those, keep the previous sample, and derive cores from the delta — the standard
psutil formula, `cores = Δcpu_seconds / Δwall_seconds`. One algorithm, three command shapes:

| Platform     | Command                                                                        | Yields                                                |
| ------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Linux, macOS | `ps -Ao pid=,pgid=,time=,rss=`                                                 | every host process tagged with its process GROUP      |
| Linux        | `/proc/<pid>/smaps_rollup` per group member (no spawn)                         | `Pss:` in kB — the proportional share of shared pages |
| Windows      | `powershell -NoProfile -NonInteractive -Command "Get-Process -Id <pids> \| …"` | `CPU` (cumulative seconds), `WorkingSet64` (bytes)    |

Sampling batches every PID into **one** spawn per poll, replacing today's spawn-per-kernel `Promise.all`.

**A kernel is a process GROUP, not a process.** `notebook.ts` spawns each kernel `detached: true`, so the
leader is its own process-group leader and every descendant it forks — the interpreter, joblib/BLAS/
multiprocessing workers, `subprocess` children — shares its pgid. Sampling the leader alone reports a
fraction of what the kernel actually holds. There is no portable pgid selector across GNU and BSD `ps`
(GNU `-g` selects by _session_), so the sampler lists the whole host once and filters to the wanted pgids
in `group()` — still one spawn per poll.

**CPU is kept per member, never pre-summed.** The sum of a group's _cumulative_ counters is not monotonic
across a membership change: when a forked worker is reaped its accumulated seconds leave the total, so the
next delta reads near zero (rendered `0.0 cores`) or negative (rendered `Unavailable`) while the group is
pegging a core. `derive` therefore sums the per-pid deltas for pids present in **both** samples. A member
that vanished contributes nothing further; one that appeared starts accumulating from the poll it appeared
in. Every term is one process's own non-negative progress, so the aggregate is monotonic by construction.
The cost is that work done entirely by a process born and reaped inside one window is invisible — an
undercount, never a fabricated figure.

**Memory is proportional (PSS) where the kernel can report it.** Summing RSS across a group counts every
copy-on-write page once per member: a leader holding 300 MB that forks three idle children reads as 1.29 GB,
a 4.03x overcount that can exceed `memory.total` and silently peg the meter (`ratio()` clamps to 1). On
Linux the sampler reads `/proc/<pid>/smaps_rollup` for each member and sums `Pss:`, which divides each shared
page by the number of processes mapping it — exactly the "how much of this machine do my kernels hold"
question the strip asks. `smaps_rollup` is the kernel's own whole-process rollup, far cheaper than parsing
`smaps`, and these are `/proc` reads rather than spawns.

Where **any** member's rollup is unreadable — macOS, Linux before 4.14, permission denied, a member that
died between the `ps` listing and the read — the group falls back to the summed RSS, because mixing PSS for
some members with RSS for others reports a figure that is neither. **That fallback overcounts shared pages,
by design:** a wrong-but-real number beats omitting a figure the machine genuinely holds. A missing rollup
never produces a `0`.

**Baselines expire.** A mark is keyed by caller scope and pid, and is dropped once it is older than 30s (the
same bound `host.ts` uses for its rolling baseline). Death-eviction only reaches pids the current poll named
and the routes only pass _active_ pids, so without an age sweep a stopped kernel's mark would live as long
as the process — unbounded growth, and a fabricated near-zero once the OS recycled that pid onto a stranger.
`derive` refuses a window that old as well, so a leaked mark could never be used even if the sweep missed it.

Each platform's stdout parser is a pure exported function taking text and returning
`Map<pgid, { cpu: Map<pid, cpu_seconds>, memory_bytes }>`, so both are testable on any host against fixture
text. `pss()` is likewise pure over fixture `smaps_rollup` text.

**The wire contract does not change.** `KernelMetrics.Sample` keeps emitting `cpu_percent` — percent of one
core, the same units `ps %cpu` used — now computed as `100 × Δcpu_seconds / Δwall_seconds` instead of read
straight from `ps`. `cpu_seconds` is internal to the sampler. `KernelCard`, `registry.ts`'s zod schema and
`notebook/runtime.ts` need no edits; `cpu_percent` simply starts telling the truth about _now_. The strip
divides by 100 to render cores.

Three approaches were rejected:

- **`Win32_PerfFormattedData_PerfProc_Process`** (the original plan) gives `PercentProcessorTime` directly, but
  the whole `Win32_PerfFormattedData_*` family returns _nothing_ when the performance-counter registry is
  corrupt — a documented Windows failure needing `lodctr /R` to repair. Silent empty results on an otherwise
  healthy machine is a bad trade for avoiding one subtraction. Its `PercentProcessorTime` is also scaled to
  `100 × logical cores`, not 0–100, which is its own footgun.
- **`wmic`** is removed. Disabled by default in Windows 11 23H2/24H2, removed from 25H2 images, and being
  dropped as a Feature on Demand entirely.
- **`bun:ffi`** calling `GetProcessTimes` + `K32GetProcessMemoryInfo` would avoid the spawn entirely, but Bun
  documents `bun:ffi` as experimental and explicitly not for production, with open Windows segfault reports
  and a `dlopen` regression in the 1.3.x Rust rewrite. This repo pins `bun@1.3.14` and uses no FFI anywhere.

Spawning PowerShell has precedent here: `util/archive.ts:11` already uses
`powershell -NoProfile -NonInteractive -Command`. `-NoProfile` matters — profile loading dominates cold start.
`Get-Process` needs no elevation for processes the caller owns, and kernels are our own children.

### Existing defect this fixes

`ps -o %cpu` is **not** an instantaneous reading. Per the procps manual, "CPU usage is currently expressed as
the percentage of time spent running during the entire lifetime of a process" — a lifetime average. A kernel
that ran a heavy job and went idle keeps reporting high; a kernel spiking right now reports low until its
average catches up. Acceptable when the number sat in a per-kernel detail card; wrong for a live host meter
that claims to show current load. Switching to a cumulative-time delta fixes it for Linux and macOS as a side
effect of making Windows work.

The first poll has no baseline, so `cpu` is **absent** for one interval and the tile reads `Unavailable` —
consistent with the never-render-0 contract. So is the first poll after a mark expires, and any poll whose
window is under a second. Memory needs no baseline and is present immediately.

### `frontend/workspace/src/atlas/HostStrip.tsx` (new)

Rendered by `ComputeSurface.tsx` above the `role="tablist"` element, so it is a property of the Compute tab
rather than of one sub-view.

Three tiles, each a value, a caption, and a two-segment meter — solid accent for the kernels' share, dim for
the remainder of host usage:

```
0 B                    0.0 cores                      0
kernels ·              by kernels ·                   kernels ·
9.3 GB free of 15.3 GB ~2 of 8 cores busy             0 running
```

The `~` on the core figure is deliberate: `busy` is an average over the sample interval, not an instant.

Own `createResource`, own 2.5 s interval, cleared on `document.hidden` and on cleanup. It never shares state
with `KernelPanel`'s poll, so neither can block the other.

## Data flow

```
ComputeSurface mounts
  ├─ HostStrip     → GET /notebook/compute              (2.5 s, machine-wide)
  └─ KernelPanel   → GET /notebook/kernels?sessionID=…  (existing, session-scoped)
```

## Copy

`KernelPanel`'s empty state becomes:

- Title: `No live kernels`
- Body: `Kernels appear here the moment this session starts computing.`

The reference reads _"…any session starts computing on this machine"_, which would be false here: the list is
session-scoped, so a kernel belonging to another session would not appear. The title matches the reference;
the body states what the list actually shows.

## Failure handling

- `/notebook/compute` fails or returns a partial body → each affected tile reads `Unavailable`. Never a
  fabricated `0` for a figure that could not be measured, never a blank tile, never a thrown boundary. This
  does not apply to a healthy response reporting zero live kernels — see the true-zero rule above, `0` there
  is the correct, measured value and must render as such, not as `Unavailable`.
- Meter fill clamps to `[0, 1]`; `available > total` or `busy > cores` from a racing sample cannot overflow
  the bar.
- `/proc/meminfo` unreadable → silent fall back to `os.freemem()`. Not an error state.
- A kernel process that exits between `list()` and `sample()` while other kernels remain live → that entry
  contributes nothing to the aggregate rather than failing the request; the field still reports the surviving
  kernels' true sum, or is omitted only if none of them sampled either.
- `/notebook/kernels` fails → the panel's fetcher resolves to no inventory rather than rejecting, the same
  shape `HostStrip` uses. An errored resource re-throws where the render path reads it, and `app.tsx`'s is
  the only `ErrorBoundary` in the app, so a rejecting 2.5 s poll replaces the entire workspace. The panel
  shows its "Kernel inventory unavailable" alert and an empty state that says the list could not be read —
  a failed poll degrades visibly rather than looking like an idle session.
- `/proc/<pid>/smaps_rollup` unreadable for any member of a group → silent fall back to the summed RSS for
  that group, which overcounts shared pages. Not an error state, and never a `0`.

## Testing

No mocks, per `AGENTS.md`.

| Test                       | Asserts                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.test.ts`             | Real-machine invariants: `total > 0`, `0 < available ≤ total`, `cores ≥ 1`, `0 ≤ busy ≤ cores`                                               |
| `host.test.ts`             | `MemAvailable` parsed from a fixture `/proc/meminfo` string; malformed input falls back                                                      |
| `host.test.ts`             | Two `snapshot()` calls in sequence return a `busy` from the rolling baseline, not a re-sample                                                |
| `host.test.ts`             | A sub-second window yields no `busy` and holds the older baseline; exactly 1 s still measures                                                |
| `host.test.ts`             | 60 concurrent `snapshot()` pairs against a held core: every reading is absent or strictly inside `(0, cores)`                                |
| `metrics.test.ts`          | `ps`, `Get-Process` and `smaps_rollup` parsers, all against fixture text, on any host platform                                               |
| `metrics.test.ts`          | `ps` elapsed-time formats parse: `0:04`, `12:34`, `1:02:03`, `2-03:04:05`                                                                    |
| `metrics.test.ts`          | Unparseable output yields `{}`, not `{ cpu_percent: NaN }`                                                                                   |
| `metrics.test.ts`          | Cores derive from a delta: two fixture samples with known Δcpu and Δwall give the expected cores; a single sample yields no `cpu` field      |
| `metrics.test.ts`          | A reaped member cannot cancel out the group's work; a new member counts only from the poll it appeared in                                    |
| `metrics.test.ts`          | A real leader forking and reaping a worker pool reports cpu on every poll while it stays busy                                                |
| `metrics.test.ts`          | A real leader touching 200 MB then forking three children reports one 200 MB footprint, not four                                             |
| `metrics.test.ts`          | A mark older than 30 s derives nothing, and the next poll of any scope sweeps it out of the baseline                                         |
| `metrics.test.ts`          | A PID present in the first sample and gone from the second drops out without throwing                                                        |
| `notebook.test.ts`         | `GET /notebook/compute` returns the shape; `kernels` sub-fields absent rather than `0` when unsampled, and a true `0` when no kernel is live |
| `ComputeSurface.test.ts`   | Strip renders before the tablist in DOM order                                                                                                |
| `HostStrip.test.ts`        | Meter clamps; `Unavailable` on a failed load; no `0` rendered for absent fields                                                              |
| `host-tiles.test.ts`       | A body missing a section degrades that tile alone and never throws on the render path                                                        |
| `KernelPanel.poll.test.ts` | A failed kernels poll resolves to no inventory instead of rejecting into the app-wide boundary                                               |

## Open risks

**The Windows sampler ships unverified.** No Windows machine is in the loop, so only its parser is tested,
against captured fixture text. The blast radius is bounded: a failing spawn returns `{}`, which is today's
Windows behaviour, so the worst case is a no-op rather than a regression. `Get-Process` is a lower-risk
target than the alternatives — it needs no performance counters, no elevation for owned processes, and no
removed tooling.

**PowerShell spawn cost.** One spawn per 2.5 s poll on Windows, only while the Compute tab is open and
visible. Batching all PIDs into a single invocation keeps it at one spawn regardless of kernel count. If this
proves too heavy in practice, the fallback is to lengthen the Windows poll interval rather than change the
mechanism.

**`ps` cumulative time resolution.** `ps -o time=` reports whole seconds. At a 2.5 s poll a lightly-loaded
kernel quantises to 0.0 or 0.4 cores with nothing between. If that reads badly, Linux can switch to
`/proc/<pid>/stat` jiffies for finer granularity, keeping `ps` for macOS — the parser seam already allows it
without touching callers.
