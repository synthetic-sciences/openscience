import crypto from "node:crypto"
import fs from "node:fs/promises"
import { WindowsJob } from "./windows-job"
import { lazy } from "@synsci/util/lazy"

/** Exact, PID-reuse-safe process-start identities shared by durable owners. */
export namespace ProcessIdentity {
  // Opened once for the process lifetime: capture() backs every ownership
  // poll, and a dlopen/dlclose pair per call is measurable on macOS.
  const libproc = lazy(async () => {
    const ffi = await import("bun:ffi")
    const lib = ffi.dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
    })
    // Keep the Library itself reachable: Bun closes the dlopen handle when the
    // Library object is collected, which would leave the memoized symbol
    // pointing into an unloaded image and crash the next call.
    return { library: lib, ptr: ffi.ptr }
  })

  async function linux(pid: number): Promise<{ raw: string; state: string } | undefined> {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return undefined
      throw error
    })
    if (!stat) return
    const close = stat.lastIndexOf(")")
    if (close < 0) return
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/)
    const state = fields[0]
    const started = fields[19]
    return state && started ? { raw: `linux:${started}`, state } : undefined
  }

  async function darwin(pid: number): Promise<string | undefined> {
    const lib = await libproc().catch((error) => {
      libproc.reset()
      throw error
    })
    // PROC_PIDTBSDINFO. The final two uint64 fields are the process start
    // time with microsecond precision, so a recycled PID never authenticates
    // an abandoned data-root operation marker.
    const info = Buffer.alloc(136)
    const size = lib.library.symbols.proc_pidinfo(pid, 3, 0n, lib.ptr(info), info.length)
    if (size !== info.length || info.readUInt32LE(12) !== pid) return
    return `darwin:${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}`
  }

  /** Stable, hashed OS process-start identity. */
  export async function capture(pid: number): Promise<string | undefined> {
    const raw = await (async () => {
      if (process.platform === "linux") return (await linux(pid))?.raw
      if (process.platform === "darwin") return darwin(pid)
      if (process.platform === "win32") return WindowsJob.identity(pid)
    })()
    return raw ? crypto.createHash("sha256").update(raw).digest("hex") : undefined
  }

  export async function owns(pid: number, expected: string | undefined): Promise<boolean> {
    if (!expected) return false
    if (process.platform === "linux") {
      const info = await linux(pid)
      if (!info || info.state === "Z") return false
      return crypto.createHash("sha256").update(info.raw).digest("hex") === expected
    }
    return (await capture(pid)) === expected
  }
}
