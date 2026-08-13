import crypto from "node:crypto"
import fs from "node:fs"
import type { ChildProcess } from "node:child_process"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { WindowsJob } from "@/process/windows-job"
import { AuthorityProcessLedger } from "@/project/authority-process"
import type { KernelProcess } from "./types"

const hooks = new Set<() => void>()
let hooked = false

const procInfo = {
  proc_pidinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
} as const

const openDarwinLibrary = () => dlopen("/usr/lib/libproc.dylib", procInfo)
let darwinLibrary: ReturnType<typeof openDarwinLibrary> | undefined

function rawToken(pid: number) {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      const start = fields[19]
      return start ? `linux:${start}` : undefined
    } catch {
      return
    }
  }
  if (process.platform === "win32") return WindowsJob.identity(pid)
  if (process.platform !== "darwin") return
  // PROC_PIDTBSDINFO exposes the kernel's microsecond-resolution process start
  // time. `ps -o lstart` only has whole-second resolution, so two successive
  // occupants of a rapidly reused PID could otherwise share the same token.
  darwinLibrary ??= openDarwinLibrary()
  const info = Buffer.alloc(136)
  const size = darwinLibrary.symbols.proc_pidinfo(pid, 3, 0n, ptr(info), info.length)
  if (size !== info.length || info.readUInt32LE(12) !== pid) return
  return `darwin:${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}`
}

function token(pid: number) {
  const raw = rawToken(pid)
  return raw ? crypto.createHash("sha256").update(raw).digest("hex") : undefined
}

function matchesToken(pid: number, expected: string) {
  const raw = rawToken(pid)
  if (!raw) return false
  const exact = crypto.createHash("sha256").update(raw).digest("hex")
  // Linux's old token was the raw boot-clock start tick, which is already an
  // exact process incarnation. Preserve safe recovery for those records while
  // refusing the former second-resolution Darwin token.
  return expected === exact || (process.platform === "linux" && expected === raw)
}

export namespace KernelProcessIdentity {
  export interface Ownership {
    id: string
    projectID: string
    sessionID: string
    authorityGeneration: string
    windowsRelease?: string
  }

  export function onExit(fn: () => void) {
    hooks.add(fn)
    if (hooked) return
    hooked = true
    process.on("exit", () => {
      for (const hook of hooks) hook()
    })
    process.on("SIGTERM", () => process.exit(128 + 15))
    process.on("SIGINT", () => process.exit(128 + 2))
  }

  export function capture(proc: ChildProcess): KernelProcess | undefined {
    if (!proc.pid) return
    return {
      pid: proc.pid,
      startedAt: Date.now(),
      token: token(proc.pid),
    }
  }

  /** Exact identity of the current backend process for durable journals that
   * must distinguish a live peer from a crashed process after PID reuse. */
  export function current(): KernelProcess {
    return {
      pid: process.pid,
      startedAt: Date.now() - process.uptime() * 1_000,
      token: token(process.pid),
    }
  }

  /** Register a newly spawned kernel before its ready handshake. Persisting the
   * returned ownership ID lets a different OpenScience server reap surviving
   * process-group children even after the recorded leader has exited. */
  export async function register(proc: ChildProcess, ownership?: Ownership): Promise<KernelProcess | undefined> {
    const identity = capture(proc)
    if (!identity || !ownership) return identity
    if (!identity.token) {
      throw new Error(`Could not establish a safe process identity for kernel child ${identity.pid}`)
    }
    const registered = await AuthorityProcessLedger.register({
      ...ownership,
      kind: "kernel",
      pid: identity.pid,
      expectedIdentity: identity.token,
    })
    if (!registered) return
    return { ...identity, ownershipID: ownership.id }
  }

  /** Enforce durable registration for KernelManager implementations that do
   * not perform the standard immediate post-spawn registration themselves. */
  export async function ensureRegistered(identity: KernelProcess | undefined, ownership: Ownership) {
    if (!identity || identity.ownershipID === ownership.id) return identity
    if (!identity.token || !matchesRecorded(identity)) {
      throw new Error("Kernel process exited or changed identity before durable registration")
    }
    const registered = await AuthorityProcessLedger.register({
      ...ownership,
      kind: "kernel",
      pid: identity.pid,
      expectedIdentity: identity.token,
    })
    if (!registered) throw new Error("Kernel process exited before durable registration")
    identity.ownershipID = ownership.id
    return identity
  }

  export function matches(proc: ChildProcess, identity?: KernelProcess) {
    if (!identity || proc.pid !== identity.pid || proc.exitCode !== null) return false
    try {
      process.kill(identity.pid, 0)
    } catch {
      return false
    }
    if (!identity.token) return true
    return matchesToken(identity.pid, identity.token)
  }

  export function matchesRecorded(identity?: KernelProcess) {
    if (!identity) return false
    try {
      process.kill(identity.pid, 0)
    } catch {
      return false
    }
    if (!identity.token) return false
    return matchesToken(identity.pid, identity.token)
  }

  export async function terminate(identity?: KernelProcess) {
    if (!identity) return false
    if (identity.ownershipID) {
      // An ownership ID is only returned after the durable record is synced.
      // If another revoker already removed that record, its removal itself is
      // proof that the exact group was successfully torn down.
      await AuthorityProcessLedger.revoke({ id: identity.ownershipID, kind: "kernel" })
      if (!matchesRecorded(identity)) return true
    }
    if (!matchesRecorded(identity)) return false
    const signal = (value: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") process.kill(identity.pid, value)
        else process.kill(-identity.pid, value)
        return true
      } catch {
        return false
      }
    }
    signal("SIGTERM")
    const wait = async (attempt = 0): Promise<boolean> => {
      if (!matchesRecorded(identity)) return true
      if (attempt >= 100) return false
      await Bun.sleep(10)
      return wait(attempt + 1)
    }
    if (await wait()) return true
    signal("SIGKILL")
    return true
  }
}
