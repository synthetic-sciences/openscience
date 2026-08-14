import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { DarwinResponsibility } from "@/process/darwin-responsibility"
import { DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX } from "@/process/darwin-responsibility-launcher"
import { WindowsJob } from "@/process/windows-job"
import { FileLease } from "@/util/file-lease"

/**
 * Durable ownership for project-authorized processes that otherwise exist only
 * in a server's memory. Trust/filesystem revocation uses this record after an
 * owning server is SIGKILLed. Every signal is guarded by an OS process-start
 * identity and, on POSIX, exact identities for every observed process-group
 * member plus the leader's live descendant closure. Linux sandboxes add a PID
 * namespace; macOS launches each durable runtime as an independent kernel
 * responsibility root, so fully reparented double-fork descendants remain
 * owned after they leave both ancestry and the POSIX process group.
 */
export namespace AuthorityProcessLedger {
  export type Kind = "pty" | "biology" | "kernel"

  interface Entry {
    version: 1
    id: string
    kind: Kind
    pid: number
    identity: string
    owns_process_group: boolean
    darwin_responsibility_uniqueid?: string
    windows_job?: string
    owner_pid: number
    project_id: string
    session_id: string
    authority_generation: string
    created_at: string
  }

  export interface Scope {
    id?: string
    kind?: Kind
    projectID?: string
    sessionID?: string
    authorityGeneration?: string
  }

  const filepath = path.join(Global.Path.data, "authority-processes.json")
  const lockpath = `${filepath}.lock`

  function valid(value: unknown): value is Entry {
    if (!value || typeof value !== "object") return false
    const item = value as Partial<Entry>
    return (
      item.version === 1 &&
      typeof item.id === "string" &&
      !!item.id &&
      (item.kind === "pty" || item.kind === "biology" || item.kind === "kernel") &&
      typeof item.pid === "number" &&
      Number.isSafeInteger(item.pid) &&
      item.pid > 0 &&
      typeof item.identity === "string" &&
      /^[a-f0-9]{64}$/.test(item.identity) &&
      typeof item.owns_process_group === "boolean" &&
      (item.darwin_responsibility_uniqueid === undefined ||
        (typeof item.darwin_responsibility_uniqueid === "string" &&
          /^[1-9][0-9]{0,19}$/.test(item.darwin_responsibility_uniqueid))) &&
      (item.windows_job === undefined || WindowsJob.valid(item.windows_job)) &&
      typeof item.owner_pid === "number" &&
      Number.isSafeInteger(item.owner_pid) &&
      item.owner_pid > 0 &&
      typeof item.project_id === "string" &&
      !!item.project_id &&
      typeof item.session_id === "string" &&
      !!item.session_id &&
      typeof item.authority_generation === "string" &&
      !!item.authority_generation &&
      typeof item.created_at === "string"
    )
  }

  async function read(): Promise<Entry[]> {
    const text = await fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (text === undefined) return []
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || !parsed.every(valid)) {
      throw new Error(`Authority process ledger ${filepath} is corrupt; refusing unsafe process revocation`)
    }
    return parsed
  }

  async function write(entries: Entry[]): Promise<void> {
    await using operation = await DataRootBarrier.enter(filepath)
    const temp = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    try {
      const handle = await fs.open(temp, "wx", 0o600)
      await handle
        .chmod(0o600)
        .then(() => handle.writeFile(JSON.stringify(entries, null, 2), "utf8"))
        .then(() => handle.sync())
        .finally(() => handle.close())
      await fs.rename(temp, filepath)
      const directory = await fs.open(path.dirname(filepath), "r").catch(() => undefined)
      await directory?.sync().catch(() => undefined)
      await directory?.close().catch(() => undefined)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  function processEnv(): Record<string, string> {
    const keys = ["PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "TMP", "TEMP"]
    return Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])))
  }

  function linuxProcess(stat: string) {
    const close = stat.lastIndexOf(")")
    if (close < 0) return
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/)
    const state = fields[0]
    const ppid = Number(fields[1])
    const pgid = Number(fields[2])
    const started = fields[19]
    if (!state || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(pgid) || pgid <= 0 || !started)
      return
    return { state, ppid, pgid, started }
  }

  async function linuxProcessFor(pid: number) {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
    return stat ? linuxProcess(stat) : undefined
  }

  async function linuxNamespacePIDs(pid: number): Promise<number[] | undefined> {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8").catch(() => undefined)
    const value = status?.match(/^NSpid:\s+(.+)$/m)?.[1]
    if (!value) return
    const result = value.trim().split(/\s+/).map(Number)
    if (!result.length || result.some((item) => !Number.isSafeInteger(item) || item <= 0)) return
    return result
  }

  async function darwinProcess(pid: number) {
    if (process.platform !== "darwin") return
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const lib = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    })
    try {
      // PROC_PIDTBSDINFO. The public proc_bsdinfo ABI is 136 bytes on all
      // supported 64-bit macOS architectures; its final two uint64 fields are
      // start time with microsecond precision. This avoids ps(1)'s one-second
      // start-time granularity, which is insufficient for PID-reuse safety.
      const info = Buffer.alloc(136)
      const size = lib.symbols.proc_pidinfo(pid, 3, 0n, ptr(info), info.length)
      if (size !== info.length || info.readUInt32LE(12) !== pid) return
      return {
        ppid: info.readUInt32LE(16),
        pgid: info.readUInt32LE(100),
        startedSeconds: info.readBigUInt64LE(120),
        startedMicroseconds: info.readBigUInt64LE(128),
      }
    } finally {
      lib.close()
    }
  }

  /** Stable, hashed OS process-start identity. */
  export async function identity(pid: number): Promise<string | undefined> {
    const raw = await (async () => {
      if (process.platform === "linux") {
        const info = await linuxProcessFor(pid)
        return info ? `linux:${info.started}` : undefined
      }
      if (process.platform === "darwin") {
        const info = await darwinProcess(pid)
        return info ? `darwin:${info.startedSeconds}:${info.startedMicroseconds}` : undefined
      }
      if (process.platform === "win32") {
        return WindowsJob.identity(pid)
      }
    })()
    return raw ? crypto.createHash("sha256").update(raw).digest("hex") : undefined
  }

  export async function owns(pid: number, expected: string | undefined): Promise<boolean> {
    if (!expected || !alive(pid)) return false
    // A zombie retains its PID and immutable start time until its parent reaps
    // it, so identity() stays useful for authenticating the descendant closure.
    // It cannot execute or receive a signal and is not a live owned process.
    if (process.platform === "linux" && (await linuxProcessFor(pid))?.state === "Z") return false
    return (await identity(pid)) === expected
  }

  async function processGroup(pid: number): Promise<number | undefined> {
    if (process.platform === "linux") return (await linuxProcessFor(pid))?.pgid
    if (process.platform === "darwin") return (await darwinProcess(pid))?.pgid
  }

  async function leadsOwnGroup(pid: number): Promise<boolean> {
    if (process.platform === "win32") return false
    return (await processGroup(pid)) === pid
  }

  interface Member {
    pid: number
    identity: string
    groupBound: boolean
    responsibilityBound: boolean
  }

  interface ProcessRow {
    pid: number
    ppid: number
    pgid: number
  }

  async function processTable(): Promise<ProcessRow[]> {
    if (process.platform === "linux") {
      const names = await fs.readdir("/proc")
      const result: ProcessRow[] = []
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue
        const pid = Number(name)
        const info = await linuxProcessFor(pid)
        if (info && info.state !== "Z") result.push({ pid, ppid: info.ppid, pgid: info.pgid })
      }
      return result
    }
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid=,pgid="], {
        env: processEnv(),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Could not enumerate authorized processes: ${stderr.trim()}`)
      return stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(
          ([pid, ppid, pgid]) =>
            Number.isSafeInteger(pid) &&
            pid > 0 &&
            Number.isSafeInteger(ppid) &&
            ppid >= 0 &&
            Number.isSafeInteger(pgid) &&
            pgid > 0,
        )
        .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }))
    }
    throw new Error(`Durable authority process teardown is unsupported on ${process.platform}`)
  }

  /** Resolve a PID reported from inside a Linux sandbox to the exact host PID
   * without weakening the PID namespace. Namespace-local numbers repeat across
   * sandboxes, so a match is accepted only when it is unique within the live,
   * identity-pinned durable leader's host descendant closure. */
  export async function resolveLinuxNamespacePID(input: {
    leaderPID: number
    leaderIdentity: string
    namespacePID: number
  }): Promise<number | undefined> {
    if (process.platform !== "linux") return
    if (!Number.isSafeInteger(input.namespacePID) || input.namespacePID <= 0) return
    if (!(await owns(input.leaderPID, input.leaderIdentity))) return
    const rows = await processTable()
    const descendants = new Set([input.leaderPID])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue
        descendants.add(row.pid)
        changed = true
      }
    }
    const candidates: number[] = []
    for (const pid of descendants) {
      const namespace = await linuxNamespacePIDs(pid)
      if (namespace?.at(-1) === input.namespacePID) candidates.push(pid)
    }
    if (candidates.length !== 1 || !(await owns(input.leaderPID, input.leaderIdentity))) return
    return candidates[0]
  }

  /** Capture exact identities for every current group member and live
   * descendant. The descendant closure catches a direct setsid()/new-session
   * escape while the registered leader remains alive. If the original PID
   * now names a different process, the old group has already ceased to exist:
   * POSIX cannot reuse a PGID while that process group still has members. */
  async function groupMembers(entry: Entry): Promise<Member[]> {
    const currentLeader = await identity(entry.pid)
    if (currentLeader && currentLeader !== entry.identity) return []
    const rows = await processTable()
    const selected = new Map<number, boolean>()
    for (const row of rows) {
      if (row.pgid === entry.pid) selected.set(row.pid, true)
    }
    if (currentLeader === entry.identity) {
      const descendants = new Set([entry.pid])
      let changed = true
      while (changed) {
        changed = false
        for (const row of rows) {
          if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue
          descendants.add(row.pid)
          selected.set(row.pid, row.pgid === entry.pid)
          changed = true
        }
      }
    }
    const responsible = new Set(
      entry.darwin_responsibility_uniqueid
        ? DarwinResponsibility.uniqueMembers(entry.darwin_responsibility_uniqueid)
        : [],
    )
    for (const pid of responsible) selected.set(pid, selected.get(pid) ?? false)
    const members: Member[] = []
    for (const [pid, groupBound] of selected) {
      const memberIdentity = await identity(pid)
      if (!memberIdentity) continue
      if (groupBound && (await processGroup(pid)) !== entry.pid) continue
      if (pid === entry.pid && memberIdentity !== entry.identity) return []
      members.push({ pid, identity: memberIdentity, groupBound, responsibilityBound: responsible.has(pid) })
    }
    return members
  }

  async function signalMember(entry: Entry, member: Member): Promise<boolean> {
    if (!(await owns(member.pid, member.identity))) return false
    if (member.groupBound && (await processGroup(member.pid)) !== entry.pid) return false
    if (
      member.responsibilityBound &&
      (!entry.darwin_responsibility_uniqueid ||
        !DarwinResponsibility.uniquelyOwns(entry.darwin_responsibility_uniqueid, member.pid))
    ) {
      return false
    }
    if (member.pid === entry.pid && member.identity !== entry.identity) return false
    // Keep the original leader until last. Its exact identity pins the PGID
    // while descendants are signalled and prevents group-number reuse.
    try {
      process.kill(member.pid, "SIGKILL")
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }

  async function teardown(entry: Entry): Promise<boolean> {
    if (process.platform === "win32") {
      if (!entry.windows_job) {
        throw new Error(`Authorized ${entry.kind} process ${entry.pid} predates Windows Job Object ownership`)
      }
      const live = await owns(entry.pid, entry.identity)
      const terminated = WindowsJob.terminate(entry.windows_job)
      if (live && !terminated && (await owns(entry.pid, entry.identity))) {
        throw new Error(`Windows Job Object ${entry.windows_job} disappeared while process ${entry.pid} remained alive`)
      }
      return live || terminated
    }
    if (!entry.owns_process_group) {
      throw new Error(`Authorized ${entry.kind} process ${entry.pid} has no safely reapable process group`)
    }

    let signalled = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const members = await groupMembers(entry)
      if (!members.length) return signalled
      // Descendants first, exact recorded leader last. A process that exits or
      // changes groups between enumeration and the identity recheck is skipped.
      members.sort((a, b) => Number(a.pid === entry.pid) - Number(b.pid === entry.pid))
      for (const member of members) signalled = (await signalMember(entry, member)) || signalled
      await Bun.sleep(20)
    }
    const remaining = await groupMembers(entry)
    throw new Error(
      `Authorized ${entry.kind} process group ${entry.pid} did not exit (${remaining.length} members remain)`,
    )
  }

  export async function register(input: {
    id: string
    kind: Kind
    pid: number
    expectedIdentity?: string
    windowsRelease?: string
    projectID: string
    sessionID: string
    authorityGeneration: string
  }): Promise<boolean> {
    if ((process.platform === "win32" || process.platform === "darwin") && !input.windowsRelease) {
      throw new Error(
        `Authorized ${input.kind} child ${input.pid} was not launched behind the ${process.platform === "win32" ? "Windows Job Object" : "macOS responsibility"} registration gate`,
      )
    }
    if (process.platform === "darwin" && !DarwinResponsibility.available()) {
      throw new Error("macOS responsibility APIs are unavailable; refusing durable process registration")
    }
    const processIdentity = await identity(input.pid)
    if (!processIdentity) {
      if (!alive(input.pid)) return false
      throw new Error(`Could not establish a safe process identity for authorized child ${input.pid}`)
    }
    if (input.expectedIdentity && input.expectedIdentity !== processIdentity) {
      throw new Error(`Authorized ${input.kind} child ${input.pid} changed identity before durable registration`)
    }
    const ownsGroup = process.platform === "win32" ? false : await leadsOwnGroup(input.pid)
    if (process.platform !== "win32" && !ownsGroup) {
      throw new Error(
        `Authorized ${input.kind} child ${input.pid} is not its own process-group leader; refusing an unreapable spawn`,
      )
    }
    await using lease = await FileLease.acquire(lockpath)
    const entries = await read()
    const index = entries.findIndex((entry) => entry.id === input.id)
    // A duplicate durable ID must never orphan the previous Job handle/tree.
    // Reap it while the shared ledger lease prevents a competing replacement.
    if ((process.platform === "win32" || process.platform === "darwin") && index >= 0) {
      await teardown(entries[index]!)
    }
    let darwinResponsibility: string | undefined
    const windowsJob =
      process.platform === "win32"
        ? WindowsJob.assign({ id: input.id, pid: input.pid, expectedIdentity: processIdentity })
        : undefined
    const next: Entry = {
      version: 1,
      id: input.id,
      kind: input.kind,
      pid: input.pid,
      identity: processIdentity,
      owns_process_group: ownsGroup,
      ...(windowsJob ? { windows_job: windowsJob } : {}),
      owner_pid: process.pid,
      project_id: input.projectID,
      session_id: input.sessionID,
      authority_generation: input.authorityGeneration,
      created_at: new Date().toISOString(),
    }
    if (index < 0) entries.push(next)
    else entries[index] = next
    await write(entries).catch((error) => {
      if (windowsJob) WindowsJob.terminate(windowsJob)
      throw error
    })
    if (windowsJob && input.windowsRelease) {
      try {
        WindowsJob.release(input.windowsRelease, input.pid)
      } catch (error) {
        await teardown(next)
        await write(entries.filter((entry) => entry.id !== input.id))
        throw error
      }
    }
    if (process.platform === "darwin" && input.windowsRelease) {
      try {
        await fs.writeFile(input.windowsRelease, String(input.pid), { encoding: "utf8", flag: "wx", mode: 0o600 })
        for (let attempt = 0; attempt < 3_000; attempt++) {
          if (!(await owns(input.pid, processIdentity))) break
          if (DarwinResponsibility.responsible(input.pid) === input.pid) {
            darwinResponsibility = DarwinResponsibility.unique(input.pid)
            if (darwinResponsibility) break
          }
          if (attempt === 2_999) {
            throw new Error(`Authorized ${input.kind} child ${input.pid} did not become a macOS responsibility root`)
          }
          await Bun.sleep(10)
        }
      } catch (error) {
        await teardown(next)
        await write(entries.filter((entry) => entry.id !== input.id))
        throw error
      }
    }
    if (darwinResponsibility) {
      next.darwin_responsibility_uniqueid = darwinResponsibility
      const position = entries.findIndex((entry) => entry.id === input.id)
      if (position >= 0) entries[position] = next
      await write(entries)
      try {
        await fs.writeFile(`${input.windowsRelease}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`, String(input.pid), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        })
      } catch (error) {
        await teardown(next)
        await write(entries.filter((entry) => entry.id !== input.id))
        throw error
      }
    }
    if (darwinResponsibility && !DarwinResponsibility.uniquelyOwns(darwinResponsibility, input.pid)) {
      await teardown(next)
      await write(entries.filter((entry) => entry.id !== input.id))
      throw new Error(`Authorized ${input.kind} child ${input.pid} failed macOS responsibility handoff`)
    }
    // Persist first, then close the observation window. If the leader exited
    // during registration, durable ownership already exists; tear down any
    // surviving same-group children before returning a failed spawn.
    if (
      !(await owns(input.pid, processIdentity)) ||
      (windowsJob && !WindowsJob.contains(windowsJob, input.pid)) ||
      (darwinResponsibility && !DarwinResponsibility.uniquelyOwns(darwinResponsibility, input.pid))
    ) {
      await teardown(next)
      await write(entries.filter((entry) => entry.id !== input.id))
      return false
    }
    return true
  }

  /** A leader can exit while background work remains in its process group.
   * Normal completion therefore tears down and verifies the whole group before
   * dropping durable ownership. */
  export async function complete(id: string): Promise<boolean> {
    await using lease = await FileLease.acquire(lockpath)
    const entries = await read()
    const entry = entries.find((item) => item.id === id)
    if (!entry) return true
    if (await owns(entry.pid, entry.identity)) return false
    await teardown(entry)
    await write(entries.filter((item) => item.id !== id))
    return true
  }

  /** Kill identity-matched children even when their owning server is gone. */
  export async function revoke(scope: Scope = {}): Promise<number> {
    await using lease = await FileLease.acquire(lockpath)
    const entries = await read()
    const retained: Entry[] = []
    let killed = 0
    const failures: unknown[] = []
    for (const entry of entries) {
      const match =
        (!scope.id || entry.id === scope.id) &&
        (!scope.kind || entry.kind === scope.kind) &&
        (!scope.projectID || entry.project_id === scope.projectID) &&
        (!scope.sessionID || entry.session_id === scope.sessionID) &&
        (!scope.authorityGeneration || entry.authority_generation === scope.authorityGeneration)
      if (!match) {
        retained.push(entry)
        continue
      }
      try {
        if (await teardown(entry)) killed++
      } catch (error) {
        retained.push(entry)
        failures.push(error)
      }
    }
    await write(retained)
    if (failures.length) throw new AggregateError(failures, "Authorized child revocation failed")
    return killed
  }

  export function pathForTests(): string {
    return filepath
  }
}
