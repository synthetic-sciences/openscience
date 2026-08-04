import { $ } from "bun"

// Live resource usage for kernel processes. Every platform can cheaply report
// cumulative CPU seconds and resident bytes for a pid, so one algorithm covers
// all three: sample, keep the previous sample, derive load from the delta.
//
// `ps -o %cpu` is deliberately NOT used — the procps manual defines it as the
// average over a process's entire lifetime, which is wrong for a live meter.
//
// Platforms or processes that cannot report a value simply omit the field —
// the UI shows "Unavailable", never 0.
export namespace KernelMetrics {
  export interface Sample {
    cpu_percent?: number
    memory_bytes?: number
  }

  export interface Reading {
    cpu_seconds: number
    memory_bytes?: number
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

  export function unix(text: string) {
    const readings = new Map<number, Reading>()
    for (const line of text.trim().split("\n")) {
      const [id, time, rss] = line.trim().split(/\s+/)
      const pid = Number.parseInt(id ?? "", 10)
      const cpu = seconds(time ?? "")
      const resident = Number.parseInt(rss ?? "", 10)
      if (!Number.isFinite(pid) || cpu === undefined) continue
      readings.set(pid, {
        cpu_seconds: cpu,
        ...(Number.isFinite(resident) ? { memory_bytes: resident * 1024 } : {}),
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
      readings.set(pid, {
        cpu_seconds: used,
        ...(Number.isFinite(resident) ? { memory_bytes: resident } : {}),
      })
    }
    return readings
  }

  // Plain space-separated lines, so Windows and unix share one output shape.
  // ConvertTo-Json is avoided: Windows PowerShell 5.1 emits a bare object for a
  // single process and an array for many, and has no -AsArray to force it.
  const script = (pids: number[]) =>
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.CPU) $($_.WorkingSet64)" }`

  const read = async (pids: number[]) => {
    if (process.platform === "win32") {
      const output = await $`powershell -NoProfile -NonInteractive -Command ${script(pids)}`
        .quiet()
        .text()
        .catch(() => "")
      return windows(output)
    }
    if (process.platform !== "darwin" && process.platform !== "linux") return new Map<number, Reading>()
    const output = await $`ps -o pid=,time=,rss= -p ${pids.join(",")}`
      .quiet()
      .text()
      .catch(() => "")
    return unix(output)
  }

  const baseline = new Map<number, { cpu_seconds: number; at: number }>()

  export function reset() {
    baseline.clear()
  }

  export async function sampleAll(pids: number[]) {
    const samples = new Map<number, Sample>()
    if (!pids.length) return samples
    const readings = await read(pids)
    const at = Date.now()
    for (const [pid, reading] of readings) {
      const previous = baseline.get(pid)
      baseline.set(pid, { cpu_seconds: reading.cpu_seconds, at })
      const elapsed = previous ? (at - previous.at) / 1_000 : 0
      const used = previous ? reading.cpu_seconds - previous.cpu_seconds : 0
      samples.set(pid, {
        ...(elapsed > 0 && used >= 0 ? { cpu_percent: (used / elapsed) * 100 } : {}),
        ...(reading.memory_bytes === undefined ? {} : { memory_bytes: reading.memory_bytes }),
      })
    }
    for (const pid of [...baseline.keys()]) if (!readings.has(pid)) baseline.delete(pid)
    return samples
  }
}
