import fs from "node:fs/promises"
import fsSync from "node:fs"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { ProcessIdentity } from "./process-identity"

const PR_SET_CHILD_SUBREAPER = 36
const PR_GET_CHILD_SUBREAPER = 37
const WNOHANG = 1
const DRAIN_DELAY_MS = 20

type Library = ReturnType<typeof dlopen>
// A launcher process activates exactly once. Keep successful FFI handles
// strongly reachable until process exit: Bun can otherwise finalize/dlclose a
// Library after runLinux drops its Handle even though native stubs may remain.
const retainedLibraries = new Set<Library>()

function systemLibraries(): string[] {
  if (process.arch === "arm64") {
    return ["libc.so.6", "/lib/aarch64-linux-gnu/libc.so.6", "/lib/libc.musl-aarch64.so.1"]
  }
  return ["libc.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/lib/libc.musl-x86_64.so.1"]
}

function openLibrary(): Library {
  let failure: unknown
  for (const candidate of systemLibraries()) {
    try {
      return dlopen(candidate, {
        prctl: {
          args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
          returns: FFIType.i32,
        },
        waitpid: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      })
    } catch (error) {
      failure = error
    }
  }
  throw failure ?? new Error("Could not load the host C library for Linux child-subreaper containment")
}

interface ProcessRow {
  pid: number
  ppid: number
  state: string
}

async function processRow(pid: number): Promise<ProcessRow | undefined> {
  const value = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined
    throw error
  })
  if (!value) return
  const close = value.lastIndexOf(")")
  if (close < 0) return
  const fields = value
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const ppid = Number(fields[1])
  if (!state || !Number.isSafeInteger(ppid) || ppid < 0) return
  return { pid, ppid, state }
}

async function processTable(): Promise<ProcessRow[]> {
  const names = await fs.readdir("/proc")
  const rows: ProcessRow[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const row = await processRow(Number(name))
    if (row) rows.push(row)
  }
  return rows
}

interface Descendant {
  pid: number
  depth: number
  state: string
}

async function descendants(): Promise<Descendant[]> {
  const rows = await processTable()
  const found: Descendant[] = []
  const seen = new Set<number>([process.pid])
  let depth = 1
  while (true) {
    const added = rows.filter((row) => !seen.has(row.pid) && seen.has(row.ppid))
    if (!added.length) break
    for (const row of added) {
      seen.add(row.pid)
      found.push({ pid: row.pid, depth, state: row.state })
    }
    depth++
  }
  return found
}

interface ExactProcess extends Descendant {
  identity: string
}

async function pinnedDescendants(): Promise<{ all: Descendant[]; live: ExactProcess[]; unverified: number }> {
  const all = await descendants()
  const live: ExactProcess[] = []
  let unverified = 0
  for (const member of all) {
    if (member.state === "Z") continue
    const identity = await ProcessIdentity.capture(member.pid)
    if (!identity) {
      if (await processRow(member.pid)) unverified++
      continue
    }
    if (!(await ProcessIdentity.owns(member.pid, identity))) continue
    live.push({ ...member, identity })
  }
  return { all, live, unverified }
}

async function signalExact(member: Pick<ExactProcess, "pid" | "identity">, signal: NodeJS.Signals): Promise<boolean> {
  if (!(await ProcessIdentity.owns(member.pid, member.identity))) return false
  try {
    process.kill(member.pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function quiesce(primary?: LinuxSubreaper.Primary): Promise<ExactProcess[]> {
  let stable = ""
  while (true) {
    const snapshot = await pinnedDescendants()
    snapshot.live.sort((a, b) => a.depth - b.depth)
    for (const member of snapshot.live) await signalExact(member, "SIGSTOP")
    if (primary && !snapshot.live.some((member) => member.pid === primary.pid)) {
      await signalExact(primary, "SIGSTOP")
    }
    await Bun.sleep(DRAIN_DELAY_MS)
    const stopped = await pinnedDescendants()
    const key = stopped.live
      .map((member) => `${member.pid}:${member.identity}`)
      .sort()
      .join(",")
    const moving = stopped.live.some((member) => member.state !== "T" && member.state !== "t")
    if (!moving && !stopped.unverified && key === stable) return stopped.live
    stable = !moving && !stopped.unverified ? key : ""
  }
}

export namespace LinuxSubreaper {
  export interface Primary {
    pid: number
    identity: string
  }

  export interface Paused extends Primary {
    depth: number
  }

  export interface Handle {
    /** Stop the complete current closure so no process can fork while an
     * owner/identity decision is temporarily unverifiable. */
    pause(primary?: Primary): Promise<Paused[]>
    /** Resume only the exact process incarnations returned by pause(). */
    resume(paused: Paused[]): Promise<void>
    /** Signal the authenticated payload closure, preserving the primary until
     * every currently visible descendant has been pinned and signalled. */
    terminate(primary: Primary): Promise<void>
    /** Kill and waitpid-reap every child adopted by this dedicated launcher. */
    drain(): Promise<void>
    close(): void
  }

  /** Establish and verify the kernel containment boundary before any payload
   * is spawned. Failure is fatal: running the command without a subreaper
   * would let setsid/double-fork descendants escape owner-death cleanup. */
  export function activate(): Handle {
    if (process.env.OPENSCIENCE_TEST_HOME && process.env.OPENSCIENCE_SUBREAPER_TEST_INIT_FAILURE === "1") {
      throw new Error("Injected Linux child-subreaper initialization failure")
    }
    if (process.platform !== "linux") throw new Error("Linux child-subreaper containment requires Linux")
    const library = openLibrary()
    const prctl = library.symbols.prctl as unknown as (
      option: number,
      arg2: number,
      arg3: number,
      arg4: number,
      arg5: number,
    ) => number
    const waitpid = library.symbols.waitpid as unknown as (pid: number, status: number, options: number) => number
    try {
      // Full /proc PPID snapshots are required for worker-thread forks as well
      // as main-thread children. Verify the inputs before spawning any body.
      fsSync.readdirSync("/proc")
      fsSync.readFileSync(`/proc/${process.pid}/stat`, "utf8")
      if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
        throw new Error("Could not enable Linux child-subreaper containment")
      }
      const state = Buffer.alloc(4)
      if (prctl(PR_GET_CHILD_SUBREAPER, ptr(state), 0, 0, 0) !== 0 || state.readInt32LE(0) !== 1) {
        throw new Error("Linux did not verify child-subreaper containment")
      }
      retainedLibraries.add(library)

      const reap = () => {
        while (waitpid(-1, 0, WNOHANG) > 0) {}
      }

      return {
        async pause(primary) {
          while (true) {
            try {
              return await quiesce(primary)
            } catch {
              // Retain the subreaper and retry rather than running a body
              // whose identity/owner cannot currently be authenticated.
              await Bun.sleep(DRAIN_DELAY_MS)
            }
          }
        },
        async resume(paused) {
          // Children first and ancestry roots last: no resumed parent can fork
          // while an already-pinned child remains stopped unexpectedly.
          const depths = [...new Set(paused.map((member) => member.depth))].sort((a, b) => b - a)
          for (const depth of depths) {
            let pending = paused.filter((member) => member.depth === depth)
            while (pending.length) {
              for (const member of pending) {
                try {
                  await signalExact(member, "SIGCONT")
                } catch {}
              }
              await Bun.sleep(DRAIN_DELAY_MS)
              const next: Paused[] = []
              for (const member of pending) {
                if (!(await ProcessIdentity.owns(member.pid, member.identity))) continue
                const row = await processRow(member.pid).catch(() => undefined)
                if (row?.state === "T" || row?.state === "t") next.push(member)
              }
              pending = next
            }
          }
        },
        async terminate(primary) {
          while (true) {
            try {
              const stopped = await quiesce(primary)
              // Descendants deepest-first after the parent-first SIGSTOP
              // sweep. The exact primary remains the final ancestry anchor.
              stopped.sort((a, b) => b.depth - a.depth)
              for (const member of stopped) {
                if (member.pid === primary.pid) continue
                await signalExact(member, "SIGKILL")
              }
              await signalExact(primary, "SIGKILL")
              if (!(await ProcessIdentity.owns(primary.pid, primary.identity))) return
            } catch {
              // A transient /proc or signal error must not tear down the
              // subreaper anchor. Retry while the exact payload remains live.
            }
            await Bun.sleep(DRAIN_DELAY_MS)
          }
        },
        async drain() {
          // Never drop the subreaper boundary while a descendant remains. An
          // uninterruptible child may delay completion, but returning would
          // reparent it to host init and violate the containment guarantee.
          while (true) {
            try {
              const stopped = await quiesce()
              stopped.sort((a, b) => b.depth - a.depth)
              for (const member of stopped) await signalExact(member, "SIGKILL")
              // The managed primary has already delivered its exit event
              // before drain() is called, so waitpid cannot steal Bun's child
              // status. Every remaining direct child is adopted.
              reap()
              if (!(await descendants()).length) return
            } catch {
              // Keep the verified subreaper alive and retry. Exiting on a
              // cleanup error would reparent the unresolved tree to host init.
            }
            await Bun.sleep(DRAIN_DELAY_MS)
          }
        },
        close() {
          // Keep libc loaded until process exit. Bun's FFI call stubs may be
          // finalized after this handle; dlclose here can invalidate them.
          void retainedLibraries
        },
      }
    } catch (error) {
      library.close()
      throw error
    }
  }
}
