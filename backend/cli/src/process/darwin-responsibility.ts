import { dlopen, FFIType, ptr } from "bun:ffi"

/**
 * macOS keeps a kernel responsibility chain independently of POSIX parentage.
 * `responsibility_get_pid_responsible_for_pid` therefore continues to point a
 * setsid()+double-fork descendant at the long-lived process that launched the
 * tree after launchd has become its PPID. That gives revocation code the
 * missing ownership predicate without trusting process names or mutable argv.
 *
 * The symbol is part of libSystem's shipped ABI but is not declared by the
 * public SDK headers. Availability is probed at runtime and all operations
 * fail closed; callers must retain their process-group/ancestry path as a
 * compatibility fallback on older macOS releases.
 */
export namespace DarwinResponsibility {
  const PROCESS_ALL_PIDS = 1
  const PROC_PIDTBSDINFO = 3
  const BSD_INFO_SIZE = 136
  const POSIX_SPAWN_SETEXEC = 0x0040

  const definitions = {
    proc_listpids: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    responsibility_get_pid_responsible_for_pid: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    responsibility_get_uniqueid_responsible_for_pid: {
      args: [FFIType.i32],
      returns: FFIType.u64,
    },
    posix_spawnattr_init: {
      args: [FFIType.ptr],
      returns: FFIType.i32,
    },
    posix_spawnattr_setflags: {
      args: [FFIType.ptr, FFIType.i16],
      returns: FFIType.i32,
    },
    responsibility_spawnattrs_setdisclaim: {
      args: [FFIType.ptr, FFIType.bool],
      returns: FFIType.i32,
    },
    posix_spawnattr_destroy: {
      args: [FFIType.ptr],
      returns: FFIType.i32,
    },
    posix_spawn: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    setsid: {
      args: [],
      returns: FFIType.i32,
    },
  } as const

  type Symbols = {
    proc_listpids(type: number, typeinfo: number, buffer: Buffer | null, size: number): number
    proc_pidinfo(pid: number, flavor: number, arg: bigint, buffer: Buffer, size: number): number
    responsibility_get_pid_responsible_for_pid(pid: number): number
    responsibility_get_uniqueid_responsible_for_pid(pid: number): bigint
    posix_spawnattr_init(attributes: Buffer): number
    posix_spawnattr_setflags(attributes: Buffer, flags: number): number
    responsibility_spawnattrs_setdisclaim(attributes: Buffer, disclaim: boolean): number
    posix_spawnattr_destroy(attributes: Buffer): number
    posix_spawn(pid: Buffer, file: Buffer, actions: null, attributes: Buffer, argv: Buffer, environment: Buffer): number
    setsid(): number
  }

  let library: ReturnType<typeof dlopen> | undefined
  let unavailable = false

  function symbols(): Symbols | undefined {
    if (process.platform !== "darwin" || unavailable) return
    try {
      library ??= dlopen("/usr/lib/libSystem.B.dylib", definitions)
      return library.symbols as unknown as Symbols
    } catch {
      unavailable = true
    }
  }

  function list(symbol: Symbols): number[] {
    // The process table can grow between the size query and copy. Add slack
    // and retry rather than silently treating a truncated snapshot as proof
    // that an owned daemon has gone away.
    for (let attempt = 0; attempt < 4; attempt++) {
      const needed = symbol.proc_listpids(PROCESS_ALL_PIDS, 0, null, 0)
      if (needed <= 0) return []
      const buffer = Buffer.alloc(needed + Math.max(16_384, needed >> 1))
      const copied = symbol.proc_listpids(PROCESS_ALL_PIDS, 0, buffer, buffer.length)
      if (copied <= 0) return []
      if (copied < buffer.length) {
        const pids: number[] = []
        for (let offset = 0; offset + 4 <= copied; offset += 4) {
          const pid = buffer.readInt32LE(offset)
          if (pid > 0) pids.push(pid)
        }
        return pids
      }
    }
    throw new Error("macOS process table changed continuously while enumerating responsibility ownership")
  }

  function info(symbol: Symbols, pid: number): Buffer | undefined {
    const info = Buffer.alloc(BSD_INFO_SIZE)
    const size = symbol.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, info, info.length)
    return size === info.length && info.readUInt32LE(12) === pid ? info : undefined
  }

  function exists(symbol: Symbols, pid: number): boolean {
    return !!info(symbol, pid)
  }

  export function available(): boolean {
    return !!symbols()
  }

  /** Exact kernel process-start token used by the trusted supervisor to notice
   * that its owning OpenScience server exited, without a PID-reuse race. */
  export function identity(pid: number): string | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 0) return
    const symbol = symbols()
    const value = symbol && info(symbol, pid)
    return value ? `${value.readBigUInt64LE(120)}:${value.readBigUInt64LE(128)}` : undefined
  }

  /** Return the kernel-designated responsible PID, or undefined when the
   * process vanished or this macOS ABI is unavailable. */
  export function responsible(pid: number): number | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 0) return
    const symbol = symbols()
    if (!symbol || !exists(symbol, pid)) return
    const value = symbol.responsibility_get_pid_responsible_for_pid(pid)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }

  /** Snapshot every live process whose kernel responsibility root is owner.
   * The owner is included only while it still exists. Callers authenticate
   * returned PIDs with their normal process-start identity before signalling. */
  export function members(owner: number): number[] {
    if (!Number.isSafeInteger(owner) || owner <= 0) return []
    const symbol = symbols()
    if (!symbol || !exists(symbol, owner)) return []
    return list(symbol).filter(
      (pid) => exists(symbol, pid) && symbol.responsibility_get_pid_responsible_for_pid(pid) === owner,
    )
  }

  /** Recheck ownership immediately before a PID-targeted operation. */
  export function owns(owner: number, pid: number): boolean {
    return responsible(pid) === owner
  }

  /** Kernel responsibility identity independent of the root process's current
   * PID incarnation. Persist this decimal string in durable ledgers. */
  export function unique(pid: number): string | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 0) return
    const symbol = symbols()
    if (!symbol || !exists(symbol, pid)) return
    const value = symbol.responsibility_get_uniqueid_responsible_for_pid(pid)
    return value > 0n ? value.toString() : undefined
  }

  /** Snapshot all live processes with an exact responsibility unique ID. */
  export function uniqueMembers(owner: string): number[] {
    if (!/^[1-9][0-9]{0,19}$/.test(owner)) return []
    const symbol = symbols()
    if (!symbol) return []
    const expected = BigInt(owner)
    return list(symbol).filter(
      (pid) => exists(symbol, pid) && symbol.responsibility_get_uniqueid_responsible_for_pid(pid) === expected,
    )
  }

  export function uniquelyOwns(owner: string, pid: number): boolean {
    return unique(pid) === owner
  }

  /** Establish a new POSIX session before a transport publishes its PID. This
   * is used only for APIs that cannot request `detached` at spawn time (the
   * MCP SDK's stdio transport). */
  export function startSession(): number {
    if (process.platform !== "darwin") throw new Error("macOS session creation is only available on Darwin")
    const symbol = symbols()
    if (!symbol) throw new Error("macOS responsibility spawn APIs are unavailable")
    return symbol.setsid()
  }

  function cstring(value: string): Buffer {
    if (value.includes("\0")) throw new Error("macOS responsibility launcher arguments cannot contain NUL bytes")
    return Buffer.from(`${value}\0`)
  }

  function pointers(values: Buffer[]): Buffer {
    const table = Buffer.alloc((values.length + 1) * 8)
    values.forEach((value, index) => table.writeBigUInt64LE(BigInt(ptr(value)), index * 8))
    return table
  }

  /** Atomically replace the current process while making its unchanged PID a
   * fresh kernel responsibility root. POSIX_SPAWN_SETEXEC preserves the
   * launcher's stdio, cwd, process group, and process-start identity. Success
   * never returns. */
  export function execSelfResponsible(input: { file: string; args: string[]; env?: NodeJS.ProcessEnv }): never {
    if (process.platform !== "darwin") throw new Error("macOS responsibility execution is only available on Darwin")
    if (!pathAbsolute(input.file))
      throw new Error(`macOS responsibility execution requires an absolute file: ${input.file}`)
    const symbol = symbols()
    if (!symbol) throw new Error("macOS responsibility spawn APIs are unavailable")

    const file = cstring(input.file)
    const argvValues = [file, ...input.args.map(cstring)]
    const environmentValues = Object.entries(input.env ?? process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [cstring(`${key}=${value}`)],
    )
    const argv = pointers(argvValues)
    const environment = pointers(environmentValues)
    const attributes = Buffer.alloc(8)
    const pid = Buffer.alloc(4)
    const check = (action: string, code: number) => {
      if (code !== 0) throw new Error(`${action} failed (errno ${code})`)
    }

    check("posix_spawnattr_init", symbol.posix_spawnattr_init(attributes))
    try {
      check("responsibility_spawnattrs_setdisclaim", symbol.responsibility_spawnattrs_setdisclaim(attributes, true))
      check("posix_spawnattr_setflags", symbol.posix_spawnattr_setflags(attributes, POSIX_SPAWN_SETEXEC))
      check("posix_spawn(POSIX_SPAWN_SETEXEC)", symbol.posix_spawn(pid, file, null, attributes, argv, environment))
    } finally {
      symbol.posix_spawnattr_destroy(attributes)
    }
    throw new Error("posix_spawn(POSIX_SPAWN_SETEXEC) returned after successful process replacement")
  }

  function pathAbsolute(value: string): boolean {
    return value.startsWith("/")
  }
}
