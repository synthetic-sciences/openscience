# Compute host strip — design

Status: approved, ready for implementation planning
Date: 2026-08-04
Branch: `openscience-ui-revamp`

## Problem

The Compute right-pane tab reports only what the *current session* owns. `KernelPanel` renders
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

| Decision | Choice | Consequence |
| --- | --- | --- |
| Metric scope | Machine-wide header, session-scoped card list | Strip is context; the list stays what you act on |
| Placement | Above the Kernels/Jobs tablist | Host capacity stays visible in both sub-views |
| Metric source | Platform agnostic, best source per OS behind one interface | Works on Linux, macOS, Windows; no caller branches |
| Per-kernel sampling | Extend to Windows | `ps` path stays for Linux/macOS; adds a third sampler |

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
no session filter, each entry sampled through `KernelMetrics`. Both are **optional**: when the platform cannot
sample a process they are omitted, never sent as `0`. This preserves the existing contract in
`notebook/runtime.ts`: *absent fields mean the platform could not report them — render "Unavailable", never
0.*

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

| Platform | Command | Yields |
| --- | --- | --- |
| Linux, macOS | `ps -o pid=,time=,rss= -p <pids>` | cumulative `[[dd-]hh:]mm:ss`, RSS in KB |
| Windows | `powershell -NoProfile -NonInteractive -Command "Get-Process -Id <pids> \| …"` | `CPU` (cumulative seconds), `WorkingSet64` (bytes) |

Sampling batches every PID into **one** spawn per poll, replacing today's spawn-per-kernel `Promise.all`.

Each platform's stdout parser is a pure exported function taking text and returning
`Map<pid, { cpu_seconds, memory_bytes }>`, so both are testable on any host against fixture text.

**The wire contract does not change.** `KernelMetrics.Sample` keeps emitting `cpu_percent` — percent of one
core, the same units `ps %cpu` used — now computed as `100 × Δcpu_seconds / Δwall_seconds` instead of read
straight from `ps`. `cpu_seconds` is internal to the sampler. `KernelCard`, `registry.ts`'s zod schema and
`notebook/runtime.ts` need no edits; `cpu_percent` simply starts telling the truth about *now*. The strip
divides by 100 to render cores.

Three approaches were rejected:

- **`Win32_PerfFormattedData_PerfProc_Process`** (the original plan) gives `PercentProcessorTime` directly, but
  the whole `Win32_PerfFormattedData_*` family returns *nothing* when the performance-counter registry is
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
consistent with the never-render-0 contract. Memory needs no baseline and is present immediately.

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

The reference reads *"…any session starts computing on this machine"*, which would be false here: the list is
session-scoped, so a kernel belonging to another session would not appear. The title matches the reference;
the body states what the list actually shows.

## Failure handling

- `/notebook/compute` fails or returns a partial body → each affected tile reads `Unavailable`. Never `0`,
  never a blank tile, never a thrown boundary.
- Meter fill clamps to `[0, 1]`; `available > total` or `busy > cores` from a racing sample cannot overflow
  the bar.
- `/proc/meminfo` unreadable → silent fall back to `os.freemem()`. Not an error state.
- A kernel process that exits between `list()` and `sample()` → that entry contributes nothing to the
  aggregate rather than failing the request.

## Testing

No mocks, per `AGENTS.md`.

| Test | Asserts |
| --- | --- |
| `host.test.ts` | Real-machine invariants: `total > 0`, `0 < available ≤ total`, `cores ≥ 1`, `0 ≤ busy ≤ cores` |
| `host.test.ts` | `MemAvailable` parsed from a fixture `/proc/meminfo` string; malformed input falls back |
| `host.test.ts` | Two `snapshot()` calls in sequence return a `busy` from the rolling baseline, not a re-sample |
| `metrics.test.ts` | `ps` and `Get-Process` output parsers, both against fixture stdout, on any host platform |
| `metrics.test.ts` | `ps` elapsed-time formats parse: `0:04`, `12:34`, `1:02:03`, `2-03:04:05` |
| `metrics.test.ts` | Unparseable output yields `{}`, not `{ cpu_percent: NaN }` |
| `metrics.test.ts` | Cores derive from a delta: two fixture samples with known Δcpu and Δwall give the expected cores; a single sample yields no `cpu` field |
| `metrics.test.ts` | A PID present in the first sample and gone from the second drops out without throwing |
| `notebook.test.ts` | `GET /notebook/compute` returns the shape; `kernels` sub-fields absent rather than `0` when unsampled |
| `ComputeSurface.test.ts` | Strip renders before the tablist in DOM order |
| `HostStrip.test.ts` | Meter clamps; `Unavailable` on a failed load; no `0` rendered for absent fields |

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
