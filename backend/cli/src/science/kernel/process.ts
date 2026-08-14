import crypto from "node:crypto"
import fs from "node:fs"
import type { ChildProcess } from "node:child_process"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { WindowsJob } from "@/process/windows-job"
import { WindowsJobLauncher } from "@/process/windows-job-launcher"
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
      // A zombie retains its start tick until the parent consumes SIGCHLD, but
      // it cannot execute or own a surviving containment tree. Treat it as
      // stopped so durable teardown does not fall through while Bun is still
      // delivering the managed ChildProcess exit event.
      if (fields[0] === "Z") return
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
    linuxOwner?: { pid: number; identity: string }
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
    if (
      process.platform === "linux" &&
      (!ownership.windowsRelease || !ownership.linuxOwner || !WindowsJobLauncher.isLinuxSubreaper(proc))
    ) {
      throw new Error("Linux kernel manager did not use the durable owner-gated subreaper launcher")
    }
    if (!identity.token) {
      throw new Error(`Could not establish a safe process identity for kernel child ${identity.pid}`)
    }
    const registered = await AuthorityProcessLedger.register({
      ...ownership,
      kind: "kernel",
      pid: identity.pid,
      expectedIdentity: identity.token,
      containment:
        process.platform === "linux"
          ? "linux_subreaper_v1"
          : process.platform === "darwin"
            ? "darwin_responsibility_v1"
            : "windows_job_v1",
    })
    if (!registered) return
    if (process.platform === "linux" && ownership.windowsRelease) {
      try {
        await WindowsJobLauncher.release(ownership.windowsRelease, identity.pid)
      } catch (error) {
        const failures: unknown[] = []
        await AuthorityProcessLedger.revoke({ id: ownership.id, kind: "kernel" }).catch((failure) =>
          failures.push(failure),
        )
        if (failures.length) {
          throw new AggregateError([error, ...failures], "Kernel launch ownership cleanup failed")
        }
        throw error
      }
    }
    return { ...identity, ownershipID: ownership.id }
  }

  /** Enforce durable registration for KernelManager implementations that do
   * not perform the standard immediate post-spawn registration themselves. */
  export async function ensureRegistered(identity: KernelProcess | undefined, ownership: Ownership) {
    if (!identity || identity.ownershipID === ownership.id) return identity
    throw new Error("Kernel manager returned a process without trusted durable containment registration")
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

  /** Synchronous process-exit handoff. A registered POSIX containment
   * supervisor must remain alive to drain its tree, so exit hooks request its
   * cooperative TERM path and never group-SIGKILL the anchor. On Windows this
   * is a handoff, not synchronous proof: server handle closure atomically
   * enforces the registered Job's KILL_ON_JOB_CLOSE policy. */
  export function terminateSync(identity?: KernelProcess): boolean {
    if (!identity?.ownershipID) return false
    if (process.platform === "win32") return true
    if (!matchesRecorded(identity)) return true
    try {
      process.kill(identity.pid, "SIGTERM")
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
      return false
    }
  }

  export async function complete(identity?: KernelProcess): Promise<boolean> {
    if (!identity?.ownershipID) return false
    return AuthorityProcessLedger.complete(identity.ownershipID)
  }

  export async function terminate(identity?: KernelProcess, pendingOwnershipID?: string) {
    const ownershipID = identity?.ownershipID ?? pendingOwnershipID
    if (ownershipID) {
      // An ownership ID is only returned after the durable record is synced.
      // If another revoker already removed that record, its removal itself is
      // proof that the exact group was successfully torn down.
      const revoked = await AuthorityProcessLedger.revoke({ id: ownershipID, kind: "kernel" })
      if (!identity || !matchesRecorded(identity)) return true
      // A returned durable identity, or a matched live ledger entry, is a
      // verified containment anchor. Never fall through to a raw process-group
      // kill while it remains alive: that can kill the supervisor before it
      // drains a setsid worker. A lexical ID with no ledger match is the sole
      // pre-registration case and may use the ordinary group fallback below.
      if (identity.ownershipID || revoked > 0) {
        throw new Error(`Registered kernel containment ${identity.pid} remained live after durable revocation`)
      }
    }
    if (!identity) return false
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
