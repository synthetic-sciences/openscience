import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"
import { DataRootBarrier } from "../global/data-root-barrier"
import { DarwinResponsibility } from "../process/darwin-responsibility"
import { DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX } from "../process/darwin-responsibility-launcher"
import { WindowsJob } from "../process/windows-job"
import { AuthorityProcessLedger } from "../project/authority-process"
import { FileLease } from "../util/file-lease"

export namespace CredentialProcessLedger {
  export type Kind = "command" | "compute" | "lsp" | "mcp" | "provider" | "modal-volume" | "local-runtime"

  interface Entry {
    version: 1
    id: string
    kind: Kind
    pid: number
    identity: string
    detached: boolean
    darwin_responsibility_uniqueid?: string
    windows_job?: string
    linux_subreaper?: boolean
    owner_pid: number
    created_at: string
    project_id?: string
    session_id?: string
    authority_generation?: string
  }

  export interface Scope {
    id?: string
    kind?: Kind
    projectID?: string
    sessionID?: string
  }

  export interface RevokeOptions {
    /** Invoked once after the exact live group/descendant identities are
     * pinned, but before they are signalled. Callers may update application
     * state or perform their existing stop callback here without creating a
     * leader-exit/reparenting gap in durable teardown. */
    onPinned?: (id: string) => Promise<void>
  }

  const filepath = path.join(Global.Path.data, "credential-processes.json")
  const lockpath = `${filepath}.lock`

  function valid(value: unknown): value is Entry {
    if (!value || typeof value !== "object") return false
    const item = value as Partial<Entry>
    return (
      item.version === 1 &&
      typeof item.id === "string" &&
      !!item.id &&
      (item.kind === "command" ||
        item.kind === "compute" ||
        item.kind === "lsp" ||
        item.kind === "mcp" ||
        item.kind === "provider" ||
        item.kind === "modal-volume" ||
        item.kind === "local-runtime") &&
      typeof item.pid === "number" &&
      Number.isSafeInteger(item.pid) &&
      item.pid > 0 &&
      typeof item.identity === "string" &&
      /^[a-f0-9]{64}$/.test(item.identity) &&
      typeof item.detached === "boolean" &&
      (item.darwin_responsibility_uniqueid === undefined ||
        (typeof item.darwin_responsibility_uniqueid === "string" &&
          /^[1-9][0-9]{0,19}$/.test(item.darwin_responsibility_uniqueid))) &&
      (item.windows_job === undefined || WindowsJob.valid(item.windows_job)) &&
      (item.linux_subreaper === undefined || typeof item.linux_subreaper === "boolean") &&
      typeof item.owner_pid === "number" &&
      Number.isSafeInteger(item.owner_pid) &&
      typeof item.created_at === "string" &&
      (item.project_id === undefined || typeof item.project_id === "string") &&
      (item.session_id === undefined || typeof item.session_id === "string") &&
      (item.authority_generation === undefined || typeof item.authority_generation === "string")
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
      throw new Error(`Credential process ledger ${filepath} is corrupt; refusing unsafe process revocation`)
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

  /** Stable OS process-start identity, hashed before persistence. */
  export async function identity(pid: number): Promise<string | undefined> {
    return AuthorityProcessLedger.identity(pid)
  }

  export async function owns(pid: number, expected: string | undefined): Promise<boolean> {
    return AuthorityProcessLedger.owns(pid, expected)
  }

  /** Diagnostic bridge for tests and inspectors that receive a PID from
   * inside a Linux sandbox. The authority ledger performs the identity-pinned
   * descendant-closure and NSpid validation. */
  export async function resolveLinuxNamespacePID(input: {
    leaderPID: number
    leaderIdentity: string
    namespacePID: number
  }): Promise<number | undefined> {
    return AuthorityProcessLedger.resolveLinuxNamespacePID(input)
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
    if (!state || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(pgid) || pgid <= 0) return
    return { state, ppid, pgid }
  }

  async function linuxProcessFor(pid: number) {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return undefined
      throw error
    })
    return stat ? linuxProcess(stat) : undefined
  }

  async function live(pid: number): Promise<boolean> {
    if (process.platform === "linux" && (await linuxProcessFor(pid))?.state === "Z") return false
    return alive(pid)
  }

  async function darwinProcess(pid: number): Promise<{ ppid: number; pgid: number } | undefined> {
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const lib = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    })
    try {
      const info = Buffer.alloc(136)
      const size = lib.symbols.proc_pidinfo(pid, 3, 0n, ptr(info), info.length)
      if (size !== info.length || info.readUInt32LE(12) !== pid) return
      return { ppid: info.readUInt32LE(16), pgid: info.readUInt32LE(100) }
    } finally {
      lib.close()
    }
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
      if (code !== 0) throw new Error(`Could not enumerate credential-bearing processes: ${stderr.trim()}`)
      return stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(
          ([pid, ppid, pgid]) =>
            Number.isSafeInteger(pid) &&
            pid! > 0 &&
            Number.isSafeInteger(ppid) &&
            ppid! >= 0 &&
            Number.isSafeInteger(pgid) &&
            pgid! > 0,
        )
        .map(([pid, ppid, pgid]) => ({ pid: pid!, ppid: ppid!, pgid: pgid! }))
    }
    throw new Error(`Durable credential process-group teardown is unsupported on ${process.platform}`)
  }

  /** Capture every current group member plus the exact live descendant
   * closure. The latter catches direct setsid()/start_new_session escapes
   * while the registered leader is still alive. A POSIX PGID cannot be reused
   * as a PID while the original process group still has members. */
  async function groupMembers(entry: Entry): Promise<{ members: Member[]; unverified: boolean }> {
    const currentLeader = await identity(entry.pid)
    if (currentLeader && currentLeader !== entry.identity) return { members: [], unverified: false }
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
    let unverified = !currentLeader && (await live(entry.pid)) && (await processGroup(entry.pid)) === entry.pid
    for (const [pid, groupBound] of selected) {
      const memberIdentity = await identity(pid)
      if (!memberIdentity) {
        if ((!groupBound || (await processGroup(pid)) === entry.pid) && (await live(pid))) {
          // A process may become temporarily opaque between enumeration and
          // identity capture. Do not authenticate or signal it, and do not
          // call the group empty while it remains live. Linux zombies are not
          // live execution principals and are filtered by live().
          unverified = true
        }
        continue
      }
      if (groupBound && (await processGroup(pid)) !== entry.pid) continue
      if (!(await owns(pid, memberIdentity))) continue
      if (pid === entry.pid && memberIdentity !== entry.identity) return { members: [], unverified: false }
      members.push({ pid, identity: memberIdentity, groupBound, responsibilityBound: responsible.has(pid) })
    }
    return { members, unverified }
  }

  async function signalMember(entry: Entry, member: Member, responsibilityPinned = false): Promise<boolean> {
    if (!(await owns(member.pid, member.identity))) return false
    if (member.groupBound && (await processGroup(member.pid)) !== entry.pid) return false
    if (
      member.responsibilityBound &&
      (!entry.darwin_responsibility_uniqueid ||
        (!DarwinResponsibility.uniquelyOwns(entry.darwin_responsibility_uniqueid, member.pid) && !responsibilityPinned))
    ) {
      return false
    }
    if (member.pid === entry.pid && member.identity !== entry.identity) return false
    try {
      process.kill(member.pid, "SIGKILL")
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }

  async function teardownLinuxSubreaper(entry: Entry, options: RevokeOptions): Promise<boolean> {
    if (!(await owns(entry.pid, entry.identity))) return false
    // Give an in-process owner its authenticated teardown hook before the
    // cooperative signal. Bash uses this to record user-abort metadata; its
    // branded Shell.killTree path may also complete the supervisor drain.
    // Re-authenticate afterwards so a callback-completed launcher (or a reused
    // PID) is never signalled by this durable fallback.
    await options.onPinned?.(entry.id)
    if (!(await owns(entry.pid, entry.identity))) return true
    // The launcher handles this control signal by stopping the payload tree,
    // killing identity-pinned descendants, waitpid-reaping adopted orphans,
    // and only then exiting. Never group-kill or SIGKILL this anchor.
    try {
      process.kill(entry.pid, "SIGTERM")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    for (let attempt = 0; attempt < 250; attempt++) {
      if (!(await owns(entry.pid, entry.identity))) {
        return true
      }
      await Bun.sleep(20)
    }
    // Keep the durable row and live subreaper anchor. A hard-kill fallback
    // would turn a diagnosable timeout into an escaped credential process.
    throw new Error(`Linux child-subreaper ${entry.pid} did not finish cooperative descendant cleanup`)
  }

  async function teardownGroup(entry: Entry, options: RevokeOptions = {}): Promise<boolean> {
    if (process.platform === "win32") {
      if (!entry.windows_job) {
        throw new Error(`Credential-bearing ${entry.kind} process ${entry.pid} predates Windows Job Object ownership`)
      }
      const live = await owns(entry.pid, entry.identity)
      if (live) await options.onPinned?.(entry.id)
      const terminated = WindowsJob.terminate(entry.windows_job)
      if (live && !terminated && (await owns(entry.pid, entry.identity))) {
        throw new Error(`Windows Job Object ${entry.windows_job} disappeared while process ${entry.pid} remained alive`)
      }
      return live || terminated
    }
    if (entry.linux_subreaper) return teardownLinuxSubreaper(entry, options)
    if (!entry.detached) {
      throw new Error(`Credential-bearing ${entry.kind} process ${entry.pid} has no safely reapable process group`)
    }
    let signalled = false
    let pinned = false
    // A trusted onPinned callback may stop the supervisor root after this
    // kernel-owned snapshot. macOS can then reassign a surviving child's live
    // responsibility value. Retain its exact process-start identity so the
    // already-proven incarnation stays signalable and is verified gone before
    // teardown returns.
    const pinnedResponsibility = new Map<number, string>()
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await groupMembers(entry)
      for (const member of snapshot.members) {
        if (member.responsibilityBound) pinnedResponsibility.set(member.pid, member.identity)
      }
      for (const [pid, memberIdentity] of pinnedResponsibility) {
        if (!(await owns(pid, memberIdentity))) {
          pinnedResponsibility.delete(pid)
          continue
        }
        if (!snapshot.members.some((member) => member.pid === pid)) {
          snapshot.members.push({
            pid,
            identity: memberIdentity,
            groupBound: false,
            responsibilityBound: true,
          })
        }
      }
      if (!snapshot.members.length && !snapshot.unverified) return signalled
      if (!pinned && snapshot.members.length) {
        await options.onPinned?.(entry.id)
        pinned = true
      }
      // Preserve the exact leader until its descendants are authenticated and
      // signalled. That pins the group identity throughout normal revocation.
      snapshot.members.sort((a, b) => Number(a.pid === entry.pid) - Number(b.pid === entry.pid))
      for (const member of snapshot.members) {
        signalled =
          (await signalMember(entry, member, pinnedResponsibility.get(member.pid) === member.identity)) || signalled
      }
      await Bun.sleep(20)
    }
    const remaining = await groupMembers(entry)
    throw new Error(
      `Credential-bearing ${entry.kind} process group ${entry.pid} did not exit (${remaining.members.length} verified members${remaining.unverified ? " plus unverified members" : ""} remain)`,
    )
  }

  export async function register(input: {
    id: string
    kind: Kind
    pid: number
    detached: boolean
    identity?: string
    projectID?: string
    sessionID?: string
    authorityGeneration?: string
    windowsRelease?: string
  }): Promise<boolean> {
    if ((process.platform === "win32" || process.platform === "darwin") && !input.windowsRelease) {
      throw new Error(
        `Credential-bearing ${input.kind} child ${input.pid} was not launched behind the ${process.platform === "win32" ? "Windows Job Object" : "macOS responsibility"} registration gate`,
      )
    }
    if (process.platform === "darwin" && !DarwinResponsibility.available()) {
      throw new Error("macOS responsibility APIs are unavailable; refusing durable process registration")
    }
    const processIdentity = input.identity ?? (await identity(input.pid))
    if (!processIdentity) {
      if (!alive(input.pid)) return false
      throw new Error(`Could not establish a safe process identity for credential-bearing child ${input.pid}`)
    }
    const requiresGroup =
      input.kind === "command" ||
      input.kind === "compute" ||
      input.kind === "lsp" ||
      input.kind === "mcp" ||
      input.kind === "provider" ||
      input.kind === "modal-volume" ||
      input.kind === "local-runtime"
    if (requiresGroup && process.platform !== "win32" && !input.detached) {
      throw new Error(`Credential-bearing ${input.kind} child ${input.pid} was not spawned in an owned process group`)
    }
    if (process.platform !== "win32" && input.detached && !(await leadsOwnGroup(input.pid))) {
      throw new Error(
        `Credential-bearing ${input.kind} child ${input.pid} is not its own process-group leader; refusing an unreapable spawn`,
      )
    }
    // Close the capture/check window before publishing durable ownership.
    if (!(await owns(input.pid, processIdentity))) return false
    await using lease = await FileLease.acquire(lockpath)
    const entries = await read()
    const index = entries.findIndex((entry) => entry.id === input.id)
    // Replacing an ID without first closing its named Job would leave the old
    // tree contained but unreachable from the durable ledger.
    if ((process.platform === "win32" || process.platform === "darwin") && index >= 0) {
      await teardownGroup(entries[index]!)
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
      detached: input.detached,
      ...(windowsJob ? { windows_job: windowsJob } : {}),
      ...(process.platform === "linux" && input.windowsRelease ? { linux_subreaper: true } : {}),
      identity: processIdentity,
      owner_pid: process.pid,
      created_at: new Date().toISOString(),
      ...(input.projectID ? { project_id: input.projectID } : {}),
      ...(input.sessionID ? { session_id: input.sessionID } : {}),
      ...(input.authorityGeneration ? { authority_generation: input.authorityGeneration } : {}),
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
        await teardownGroup(next)
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
            throw new Error(
              `Credential-bearing ${input.kind} child ${input.pid} did not become a macOS responsibility root`,
            )
          }
          await Bun.sleep(10)
        }
      } catch (error) {
        await teardownGroup(next)
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
        await teardownGroup(next)
        await write(entries.filter((entry) => entry.id !== input.id))
        throw error
      }
    }
    if (darwinResponsibility && !DarwinResponsibility.uniquelyOwns(darwinResponsibility, input.pid)) {
      await teardownGroup(next)
      await write(entries.filter((entry) => entry.id !== input.id))
      throw new Error(`Credential-bearing ${input.kind} child ${input.pid} failed macOS responsibility handoff`)
    }
    // Persist first, then close the final observation window. If the leader
    // exited during publication, durable ownership already exists and can
    // reap every surviving original-group member before reporting a failed
    // spawn. A teardown failure deliberately leaves the entry on disk.
    if (
      !(await owns(input.pid, processIdentity)) ||
      (windowsJob && !WindowsJob.contains(windowsJob, input.pid)) ||
      (darwinResponsibility && !DarwinResponsibility.uniquelyOwns(darwinResponsibility, input.pid))
    ) {
      if (next.detached || windowsJob) await teardownGroup(next)
      await write(entries.filter((entry) => entry.id !== input.id))
      return false
    }
    return true
  }

  export async function remove(id: string): Promise<void> {
    await using lease = await FileLease.acquire(lockpath)
    const entries = await read()
    const remaining = entries.filter((entry) => entry.id !== id)
    if (remaining.length !== entries.length) await write(remaining)
  }

  /** Remove a normal-completion entry only after its exact process and every
   * same-group descendant are gone. Background work is reaped before durable
   * credential ownership can be dropped. */
  export async function complete(id: string): Promise<boolean> {
    await using lease = await FileLease.acquire(lockpath)
    const entries = await read()
    const entry = entries.find((item) => item.id === id)
    if (!entry) return true
    if (await owns(entry.pid, entry.identity)) return false
    if (entry.detached || entry.windows_job) await teardownGroup(entry)
    await write(entries.filter((item) => item.id !== id))
    return true
  }

  async function killExactProcess(entry: Entry): Promise<boolean> {
    if (!(await owns(entry.pid, entry.identity))) return false
    if (process.platform === "win32") {
      const proc = Bun.spawn(["taskkill", "/pid", String(entry.pid), "/f", "/t"], {
        env: processEnv(),
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      await proc.exited
    } else {
      try {
        process.kill(entry.pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await owns(entry.pid, entry.identity))) return true
      await Bun.sleep(20)
    }
    throw new Error(`Credential-bearing ${entry.kind} process ${entry.pid} did not exit`)
  }

  async function teardown(entry: Entry, options: RevokeOptions = {}): Promise<boolean> {
    if (entry.detached || entry.windows_job) return teardownGroup(entry, options)
    if (await owns(entry.pid, entry.identity)) await options.onPinned?.(entry.id)
    return killExactProcess(entry)
  }

  export function killExact(input: {
    id: string
    kind: Kind
    pid: number
    identity: string
    detached: boolean
  }): Promise<boolean> {
    return teardown({
      version: 1,
      ...input,
      ...(process.platform === "win32" ? { windows_job: undefined } : {}),
      owner_pid: 0,
      created_at: new Date(0).toISOString(),
    })
  }

  /** Kill exact, identity-matched children even when their owner server died. */
  export async function revoke(scope?: Kind | Scope, options: RevokeOptions = {}): Promise<number> {
    await using lease = await FileLease.acquire(lockpath)
    const entries = await read()
    const retained: Entry[] = []
    let killed = 0
    const failures: unknown[] = []
    for (const entry of entries) {
      const match =
        typeof scope === "string"
          ? entry.kind === scope
          : (!scope?.id || entry.id === scope.id) &&
            (!scope?.kind || entry.kind === scope.kind) &&
            (!scope?.projectID || !entry.project_id || entry.project_id === scope.projectID) &&
            (!scope?.sessionID || !entry.session_id || entry.session_id === scope.sessionID)
      if (!match) {
        retained.push(entry)
        continue
      }
      try {
        if (await teardown(entry, options)) killed++
      } catch (error) {
        retained.push(entry)
        failures.push(error)
      }
    }
    await write(retained)
    if (failures.length) throw new AggregateError(failures, "Credential-bearing child revocation failed")
    return killed
  }

  export function pathForTests(): string {
    return filepath
  }
}
