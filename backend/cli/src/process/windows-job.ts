import crypto from "node:crypto"
import fs from "node:fs"
import { dlopen, FFIType } from "bun:ffi"

/**
 * Windows process-tree ownership backed by named Job Objects.
 *
 * A handle is intentionally kept open by the process that registers the
 * child. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE then makes an ungraceful owner
 * exit an OS-enforced teardown boundary. The random, persisted name lets a
 * different OpenScience process open and terminate the same job while the
 * original owner is still alive.
 */
export namespace WindowsJob {
  type Handle = number | bigint

  export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
  export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
  export const EXTENDED_LIMIT_SIZE_X64 = 144
  export const LIMIT_FLAGS_OFFSET_X64 = 16

  const JOB_OBJECT_TERMINATE = 0x0008
  const JOB_OBJECT_QUERY = 0x0004
  const SYNCHRONIZE = 0x00100000
  const PROCESS_TERMINATE = 0x0001
  const PROCESS_SET_QUOTA = 0x0100
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  const WAIT_OBJECT_0 = 0
  const WAIT_FAILED = 0xffffffff
  const WAIT_TIMEOUT = 0x00000102
  const ERROR_FILE_NOT_FOUND = 2
  const ERROR_ALREADY_EXISTS = 183
  const jobs = new Map<string, Handle>()

  const definitions = {
    CreateJobObjectW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u64,
    },
    OpenJobObjectW: {
      args: [FFIType.u32, FFIType.i32, FFIType.ptr],
      returns: FFIType.u64,
    },
    SetInformationJobObject: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: {
      args: [FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    TerminateJobObject: {
      args: [FFIType.u64, FFIType.u32],
      returns: FFIType.i32,
    },
    IsProcessInJob: {
      args: [FFIType.u64, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    OpenProcess: {
      args: [FFIType.u32, FFIType.i32, FFIType.u32],
      returns: FFIType.u64,
    },
    GetProcessTimes: {
      args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    WaitForSingleObject: {
      args: [FFIType.u64, FFIType.u32],
      returns: FFIType.u32,
    },
    CloseHandle: {
      args: [FFIType.u64],
      returns: FFIType.i32,
    },
    GetLastError: {
      args: [],
      returns: FFIType.u32,
    },
  } as const

  const openKernel = () => dlopen("kernel32.dll", definitions)
  let kernel: ReturnType<typeof openKernel> | undefined

  function api() {
    if (process.platform !== "win32") throw new Error("Windows Job Objects are only available on Windows")
    if (process.arch !== "x64" && process.arch !== "arm64") {
      throw new Error(`Windows Job Objects require a 64-bit Windows runtime, received ${process.arch}`)
    }
    kernel ??= openKernel()
    return kernel.symbols
  }

  function wide(value: string): Buffer {
    return Buffer.from(`${value}\0`, "utf16le")
  }

  function empty(handle: Handle): boolean {
    return handle === 0 || handle === 0n
  }

  function code(): number {
    return Number(api().GetLastError())
  }

  function failure(action: string, error = code()): Error {
    return new Error(`${action} failed (Win32 error ${error})`)
  }

  function close(handle: Handle): void {
    if (empty(handle)) return
    api().CloseHandle(handle)
  }

  function limits(): Buffer {
    const info = Buffer.alloc(EXTENDED_LIMIT_SIZE_X64)
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET_X64)
    return info
  }

  function create(name: string): Handle {
    const symbols = api()
    const handle = symbols.CreateJobObjectW(null, wide(name)) as Handle
    if (empty(handle)) throw failure(`CreateJobObjectW(${name})`)
    const created = code()
    if (created === ERROR_ALREADY_EXISTS) {
      close(handle)
      throw failure(`CreateJobObjectW(${name})`, created)
    }
    const info = limits()
    if (!symbols.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length)) {
      const error = failure(`SetInformationJobObject(${name})`)
      close(handle)
      throw error
    }
    return handle
  }

  function open(name: string, access = JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY | SYNCHRONIZE): Handle | undefined {
    const handle = api().OpenJobObjectW(access, 0, wide(name)) as Handle
    if (!empty(handle)) return handle
    const error = code()
    if (error === ERROR_FILE_NOT_FOUND) return
    throw failure(`OpenJobObjectW(${name})`, error)
  }

  function processHandle(pid: number, access: number): Handle | undefined {
    const handle = api().OpenProcess(access, 0, pid) as Handle
    if (!empty(handle)) return handle
  }

  export function valid(name: string | undefined): name is string {
    return !!name && /^Local\\OpenScience-[a-f0-9]{64}$/.test(name)
  }

  export function name(id: string, nonce: string = crypto.randomUUID()): string {
    const digest = crypto.createHash("sha256").update(`${id}\0${nonce}`).digest("hex")
    return `Local\\OpenScience-${digest}`
  }

  function identityForHandle(handle: Handle): string | undefined {
    const creation = Buffer.alloc(8)
    const exit = Buffer.alloc(8)
    const kernelTime = Buffer.alloc(8)
    const userTime = Buffer.alloc(8)
    if (!api().GetProcessTimes(handle, creation, exit, kernelTime, userTime)) return
    const ticks = (BigInt(creation.readUInt32LE(4)) << 32n) | BigInt(creation.readUInt32LE(0))
    return `win32:${ticks}`
  }

  function hashedIdentity(handle: Handle): string | undefined {
    const raw = identityForHandle(handle)
    return raw ? crypto.createHash("sha256").update(raw).digest("hex") : undefined
  }

  /**
   * Atomically establishes the OS ownership boundary for a live child.
   *
   * The expected identity is checked through the same process handle that is
   * assigned to the Job. This closes the PID-reuse window between a ledger's
   * initial identity capture and acquiring its cross-process write lease.
   */
  export function assign(input: { id: string; pid: number; expectedIdentity?: string }): string {
    const job = name(input.id)
    const handle = create(job)
    const child = processHandle(
      input.pid,
      PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
    )
    if (!child) {
      const error = failure(`OpenProcess(${input.pid})`)
      close(handle)
      throw error
    }
    try {
      if (input.expectedIdentity && hashedIdentity(child) !== input.expectedIdentity) {
        throw new Error(`Process ${input.pid} changed identity before Windows Job Object assignment`)
      }
      if (!api().AssignProcessToJobObject(handle, child)) {
        throw failure(`AssignProcessToJobObject(${input.pid})`)
      }
      const member = Buffer.alloc(4)
      if (!api().IsProcessInJob(child, handle, member)) {
        throw failure(`IsProcessInJob(${input.pid})`)
      }
      if (!member.readUInt32LE()) throw new Error(`Process ${input.pid} was not retained by Windows Job Object ${job}`)
      jobs.set(job, handle)
      return job
    } catch (error) {
      close(handle)
      throw error
    } finally {
      close(child)
    }
  }

  /** Stable process-start identity from the kernel's creation FILETIME. */
  export function identity(pid: number): string | undefined {
    if (process.platform !== "win32") return
    const handle = processHandle(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    if (!handle) return
    try {
      return identityForHandle(handle)
    } finally {
      close(handle)
    }
  }

  export function contains(name: string, pid: number): boolean {
    const job = jobs.get(name) ?? open(name)
    if (!job) return false
    const owned = jobs.has(name)
    const child = processHandle(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    if (!child) {
      if (!owned) close(job)
      return false
    }
    const member = Buffer.alloc(4)
    try {
      if (!api().IsProcessInJob(child, job, member)) {
        throw failure(`IsProcessInJob(${pid})`)
      }
      return member.readUInt32LE() !== 0
    } finally {
      close(child)
      if (!owned) close(job)
    }
  }

  /** Terminates the named job and verifies that its full process tree exits. */
  export function terminate(name: string): boolean {
    const held = jobs.get(name)
    const job = held ?? open(name)
    if (!job) return false
    try {
      if (!api().TerminateJobObject(job, 1)) throw failure(`TerminateJobObject(${name})`)
      const result = Number(api().WaitForSingleObject(job, 5_000))
      if (result === WAIT_OBJECT_0) return true
      if (result === WAIT_TIMEOUT) throw new Error(`Windows Job Object ${name} did not terminate within 5000ms`)
      if (result === WAIT_FAILED) throw failure(`WaitForSingleObject(${name})`)
      throw new Error(`WaitForSingleObject(${name}) returned ${result}`)
    } finally {
      if (held) jobs.delete(name)
      close(job)
    }
  }

  export function heldForTests(name: string): boolean {
    return jobs.has(name)
  }

  export function limitsForTests(): Buffer {
    return limits()
  }

  export function release(file: string, pid: number): void {
    fs.writeFileSync(file, String(pid), { encoding: "utf8", flag: "wx", mode: 0o600 })
  }
}
