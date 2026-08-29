import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { AuthorityProcessLedger } from "@/project/authority-process"
import { ProcessIdentity } from "@/process/process-identity"
import { DataRoot } from "./data-root"
import { DataRootBarrier } from "./data-root-barrier"

export namespace DataRelocation {
  export type Phase = "copying" | "ready" | "publishing" | "published" | "switched"

  export interface State {
    id?: string
    phase: Phase | "recovery_required"
    source?: string
    target?: string
    started_at?: string
    updated_at?: string
    active?: boolean
    error?: string
  }

  export interface Result {
    source: string
    target: string
    files: number
    bytes: number
    backup?: string
    warning?: string
  }

  const pointer = () => path.join(Global.Path.config, "data-location")
  const journalFile = () => path.join(Global.Path.config, "data-relocation.json")
  const minimumReserve = 256 * 1024 * 1024
  const maximumReserve = 2 * 1024 * 1024 * 1024
  const transient = /(?:\.lock|\.tmp|\.partial|\.next|\.dead)$/
  // These roots contain OpenScience-owned metadata and process state. A
  // suffix match is safe only inside them: workspaces, managed projects, and
  // worktrees can contain ordinary user files named bun.lock, uv.lock,
  // report.partial, or database journals that must move with their database.
  const transientRoots = new Set([
    "artifact-store",
    "authority",
    "compute",
    "file-trash",
    "kernel-registry",
    "local-runtime",
    "log",
    "migrations",
    "project-leases",
    "provenance",
    "runtime",
    "session-delete",
    "settings",
    "storage",
    "trace",
  ])
  const skipped = new Set([
    path.join("artifact-store", "artifacts.db-wal"),
    path.join("artifact-store", "artifacts.db-shm"),
    path.join("settings", "memory", "index.db"),
    path.join("settings", "memory", "index.db-wal"),
    path.join("settings", "memory", "index.db-shm"),
  ])

  interface Journal {
    version: 1
    id: string
    mode: "relocate" | "reset"
    source: string
    target: string
    stage: string
    phase: Phase
    replace_empty: boolean
    copied?: { files: number; bytes: number }
    backup?: string
    created_at: string
    updated_at: string
    owner: { pid: number; identity: string }
  }

  function appTransient(relative: string, name: string) {
    if (!transient.test(name)) return false
    const [root, ...rest] = relative.split(path.sep)
    return rest.length === 0 || transientRoots.has(root!)
  }

  function inside(parent: string, candidate: string) {
    const relative = path.relative(parent, candidate)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  function safeRelative(value: string) {
    return !path.isAbsolute(value) && !path.normalize(value).split(/[\\/]/).includes("..")
  }

  async function hash(filepath: string) {
    const digest = createHash("sha256")
    for await (const chunk of createReadStream(filepath)) digest.update(chunk)
    return digest.digest("hex")
  }

  async function syncDirectory(directory: string) {
    const handle = await fs.open(directory, "r")
    try {
      await handle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Node does not expose a stronger directory durability primitive on
      // platforms/filesystems that reject fsync on directory handles.
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EISDIR") throw error
    } finally {
      await handle.close()
    }
  }

  async function atomicWrite(filepath: string, content: string) {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      await fs.rename(temporary, filepath)
      await syncDirectory(path.dirname(filepath))
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async function durableRename(source: string, destination: string) {
    await fs.rename(source, destination)
    const sourceParent = path.dirname(source)
    const destinationParent = path.dirname(destination)
    await syncDirectory(destinationParent)
    if (sourceParent !== destinationParent) await syncDirectory(sourceParent)
  }

  async function durableRemove(filepath: string, options: { recursive?: boolean } = {}) {
    const exists = await fs.lstat(filepath).catch(() => undefined)
    if (!exists) return
    await fs.rm(filepath, { force: true, recursive: options.recursive ?? false })
    await syncDirectory(path.dirname(filepath))
  }

  async function durableRemoveEmptyDirectory(directory: string) {
    await fs.rmdir(directory)
    await syncDirectory(path.dirname(directory))
  }

  function journalStage(target: string, id: string) {
    return path.join(path.dirname(target), `.${path.basename(target)}.openscience-${id}`)
  }

  function parseJournal(value: unknown): Journal {
    if (!value || typeof value !== "object") throw new Error("Relocation journal is not an object")
    const record = value as Partial<Journal>
    const phases = new Set<Phase>(["copying", "ready", "publishing", "published", "switched"])
    if (
      record.version !== 1 ||
      typeof record.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(record.id) ||
      (record.mode !== "relocate" && record.mode !== "reset") ||
      typeof record.source !== "string" ||
      !path.isAbsolute(record.source) ||
      typeof record.target !== "string" ||
      !path.isAbsolute(record.target) ||
      typeof record.stage !== "string" ||
      record.stage !== journalStage(record.target, record.id) ||
      typeof record.phase !== "string" ||
      !phases.has(record.phase as Phase) ||
      typeof record.replace_empty !== "boolean" ||
      typeof record.created_at !== "string" ||
      typeof record.updated_at !== "string"
    ) {
      throw new Error("Relocation journal has an invalid or unsafe shape")
    }
    if (
      !record.owner ||
      !Number.isSafeInteger(record.owner.pid) ||
      record.owner.pid <= 0 ||
      !/^[a-f0-9]{64}$/.test(record.owner.identity)
    ) {
      throw new Error("Relocation journal is missing an exact process owner")
    }
    if (
      record.source === record.target ||
      inside(record.source, record.target) ||
      inside(record.target, record.source)
    ) {
      throw new Error("Relocation journal contains overlapping data roots")
    }
    if (record.backup !== undefined) {
      const prefix = `${record.target}.pre-reset-`
      if (
        record.mode !== "reset" ||
        !record.backup.startsWith(prefix) ||
        path.dirname(record.backup) !== path.dirname(record.target)
      ) {
        throw new Error("Relocation journal contains an unsafe backup path")
      }
    }
    if (record.copied !== undefined) {
      if (
        !Number.isSafeInteger(record.copied.files) ||
        record.copied.files < 0 ||
        !Number.isSafeInteger(record.copied.bytes) ||
        record.copied.bytes < 0
      ) {
        throw new Error("Relocation journal contains invalid copy totals")
      }
    } else if (record.phase !== "copying") {
      throw new Error("Relocation journal is missing verified copy totals")
    }
    return record as Journal
  }

  async function readJournal(): Promise<Journal | undefined> {
    const raw = await fs.readFile(journalFile(), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (raw === undefined) return
    try {
      return parseJournal(JSON.parse(raw))
    } catch (error) {
      throw new Error(
        `Storage relocation recovery is blocked by ${journalFile()}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async function writeJournal(value: Journal): Promise<Journal> {
    const next = { ...value, updated_at: new Date().toISOString() }
    await atomicWrite(journalFile(), `${JSON.stringify(next)}\n`)
    return next
  }

  async function clearJournal() {
    await durableRemove(journalFile())
  }

  async function owner() {
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error(`Could not establish an exact identity for relocation process ${process.pid}`)
    return { pid: process.pid, identity }
  }

  function sqliteString(value: string) {
    return `'${value.replaceAll("'", "''")}'`
  }

  async function snapshotDatabase(source: string, destination: string) {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    const db = new Database(source, { readonly: true })
    try {
      db.exec(`VACUUM INTO ${sqliteString(destination)}`)
    } finally {
      db.close()
    }
    const copied = new Database(destination, { readonly: true })
    try {
      const integrity = copied.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
        throw new Error(`SQLite integrity check failed for ${destination}`)
      }
      const foreign = copied.query("PRAGMA foreign_key_check").all()
      if (foreign.length) throw new Error(`SQLite foreign-key check failed for ${destination}`)
    } finally {
      copied.close()
    }
  }

  async function verifyArtifacts(root: string) {
    const database = path.join(root, "artifact-store", "artifacts.db")
    if (!(await fs.lstat(database).catch(() => undefined))) return
    const db = new Database(database, { readonly: true })
    try {
      const rows = db.query("SELECT sha256, size, path FROM blobs ORDER BY sha256").all() as Array<{
        sha256: string
        size: number
        path: string
      }>
      for (const row of rows) {
        if (!safeRelative(row.path)) throw new Error(`Artifact blob has an unsafe path: ${row.path}`)
        const filepath = path.join(root, "artifact-store", row.path)
        const stat = await fs.lstat(filepath).catch(() => undefined)
        if (
          !stat?.isFile() ||
          stat.isSymbolicLink() ||
          stat.size !== row.size ||
          (await hash(filepath)) !== row.sha256
        ) {
          throw new Error(`Artifact blob ${row.sha256} failed relocation verification`)
        }
      }
    } finally {
      db.close()
    }
  }

  async function snapshot(source: string, destination: string): Promise<{ files: number; bytes: number }> {
    const records: Array<{ source: string; destination: string; bytes: number; sha256: string }> = []
    const directories = new Set<string>()
    const stack: Array<{ source: string; destination: string; relative: string }> = [
      { source, destination, relative: "" },
    ]
    while (stack.length) {
      const current = stack.pop()
      if (!current) continue
      await fs.mkdir(current.destination, { recursive: true })
      directories.add(current.destination)
      const entries = await fs.readdir(current.source, { withFileTypes: true })
      for (const entry of entries) {
        const relative = path.join(current.relative, entry.name)
        if (relative === path.join("artifact-store", "partial")) continue
        if (skipped.has(relative) || appTransient(relative, entry.name)) continue
        const from = path.join(current.source, entry.name)
        const to = path.join(current.destination, entry.name)
        const stat = await fs.lstat(from)
        if (entry.isDirectory()) {
          await fs.mkdir(to, { recursive: true, mode: stat.mode & 0o777 })
          stack.push({ source: from, destination: to, relative })
          continue
        }
        if (entry.isSymbolicLink()) {
          const resolved = await fs.realpath(from)
          if (!inside(source, resolved)) throw new Error(`Data symlink escapes the active root: ${relative}`)
          const mapped = path.join(destination, path.relative(source, resolved))
          const resolvedStat = await fs.stat(resolved)
          await fs.symlink(path.relative(path.dirname(to), mapped), to, resolvedStat.isDirectory() ? "dir" : "file")
          continue
        }
        if (!entry.isFile()) throw new Error(`Unsupported data entry during relocation: ${relative}`)
        if (relative === path.join("artifact-store", "artifacts.db")) {
          await snapshotDatabase(from, to)
          const copied = await fs.stat(to)
          records.push({ source: from, destination: to, bytes: copied.size, sha256: await hash(to) })
          continue
        }
        const before = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev }
        await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL)
        await fs.chmod(to, stat.mode & 0o777)
        const [after, sourceHash, targetHash] = await Promise.all([fs.stat(from), hash(from), hash(to)])
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino ||
          after.dev !== before.dev ||
          sourceHash !== targetHash
        ) {
          throw new Error(`Data changed while it was being relocated: ${relative}`)
        }
        records.push({ source: from, destination: to, bytes: before.size, sha256: targetHash })
      }
    }

    for (const record of records) {
      const stat = await fs.lstat(record.destination)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes) {
        throw new Error(`Relocated file failed structural verification: ${record.destination}`)
      }
      if ((await hash(record.destination)) !== record.sha256) {
        throw new Error(`Relocated file failed checksum verification: ${record.destination}`)
      }
      const handle = await fs.open(record.destination, "r")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    await verifyArtifacts(destination)
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory)
    return { files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0) }
  }

  async function estimate(source: string): Promise<{ files: number; bytes: number }> {
    let files = 0
    let bytes = 0
    const stack: Array<{ directory: string; relative: string }> = [{ directory: source, relative: "" }]
    while (stack.length) {
      const current = stack.pop()
      if (!current) continue
      for (const entry of await fs.readdir(current.directory, { withFileTypes: true })) {
        const relative = path.join(current.relative, entry.name)
        if (relative === path.join("artifact-store", "partial")) continue
        if (skipped.has(relative) || appTransient(relative, entry.name)) continue
        const filepath = path.join(current.directory, entry.name)
        if (entry.isDirectory()) {
          stack.push({ directory: filepath, relative })
          continue
        }
        if (entry.isSymbolicLink()) {
          const resolved = await fs.realpath(filepath)
          if (!inside(source, resolved)) throw new Error(`Data symlink escapes the active root: ${relative}`)
          continue
        }
        if (!entry.isFile()) throw new Error(`Unsupported data entry during relocation: ${relative}`)
        const stat = await fs.lstat(filepath)
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isSafeInteger(bytes + stat.size)) {
          throw new Error("The data snapshot is too large to verify safely")
        }
        files++
        bytes += stat.size
      }
    }
    return { files, bytes }
  }

  function bytesLabel(value: number) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"]
    let amount = value
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024
      unit++
    }
    return `${amount >= 10 || unit === 0 ? Math.ceil(amount) : amount.toFixed(1)} ${units[unit]}`
  }

  async function preflightCapacity(target: string, required: number) {
    const volume = await fs.statfs(path.dirname(target))
    const available = Number(volume.bavail) * Number(volume.bsize)
    if (!Number.isSafeInteger(available) || available < 0) {
      throw new Error(`Could not establish safe free-space capacity for ${path.dirname(target)}`)
    }
    const reserve = Math.max(minimumReserve, Math.min(maximumReserve, Math.ceil(required * 0.1)))
    const total = required + reserve
    if (!Number.isSafeInteger(total) || available < total) {
      throw new Error(
        `Not enough free space at ${path.dirname(target)}. The verified move needs ${bytesLabel(required)} plus a ${bytesLabel(reserve)} safety reserve, but only ${bytesLabel(available)} is available.`,
      )
    }
    return { available, required, reserve }
  }

  async function destination(raw: string) {
    const expanded = raw.replace(/^~(?=$|\/)/, Global.Path.home)
    if (!path.isAbsolute(expanded)) throw new Error("Path must be absolute")
    const target = path.resolve(expanded)
    const parent = path.dirname(target)
    await fs.mkdir(parent, { recursive: true })
    const canonicalParent = await fs.realpath(parent)
    return path.join(canonicalParent, path.basename(target))
  }

  async function current() {
    return fs.realpath(Global.Path.data)
  }

  async function validateTarget(source: string, target: string, allowExisting: boolean) {
    if (target === source) throw new Error("Already the current location")
    if (inside(source, target)) throw new Error("Target cannot be inside the current data directory")
    if (inside(target, source)) throw new Error("Target cannot contain the current data directory")
    if (target === Global.Path.home || path.dirname(target) === target) {
      throw new Error("Choose a dedicated data directory, not a home or filesystem root")
    }
    const stat = await fs.lstat(target).catch(() => undefined)
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Target must be an ordinary directory")
    const contents = await fs.readdir(target)
    if (contents.length && !allowExisting) throw new Error("Target directory is not empty")
  }

  async function targetDirectory(filepath: string) {
    const stat = await fs.lstat(filepath).catch(() => undefined)
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Storage relocation recovery expected an ordinary directory at ${filepath}`)
    }
    return stat
  }

  async function publish(input: Journal): Promise<Journal> {
    let journal = input.phase === "publishing" ? input : await writeJournal({ ...input, phase: "publishing" })
    const stage = await targetDirectory(journal.stage)
    const target = await targetDirectory(journal.target)
    const backup = journal.backup ? await targetDirectory(journal.backup) : undefined

    if (stage) {
      if (journal.backup) {
        if (backup) {
          if (target) throw new Error("Storage relocation recovery found both the old and backed-up targets")
        } else {
          if (!target) throw new Error("Storage relocation recovery could not find the target that must be backed up")
          await durableRename(journal.target, journal.backup)
        }
      } else if (journal.replace_empty) {
        if (target) {
          const contents = await fs.readdir(journal.target)
          if (contents.length) throw new Error("Storage relocation target changed after it was validated")
          await durableRemoveEmptyDirectory(journal.target)
        }
      } else if (target) {
        throw new Error("Storage relocation target appeared after it was validated")
      }
      await durableRename(journal.stage, journal.target)
    } else {
      if (!target) throw new Error("Storage relocation recovery could not find the verified staged or published copy")
      if (journal.backup && !backup) {
        throw new Error("Storage relocation recovery could not find the preserved pre-reset directory")
      }
    }

    journal = await writeJournal({ ...journal, phase: "published" })
    return journal
  }

  async function compatibility(journal: Journal) {
    return journal.mode === "reset"
      ? await durableRemove(pointer())
          .then(() => undefined)
          .catch((error) => `The active data root changed, but the legacy pointer cleanup failed: ${String(error)}`)
      : await atomicWrite(pointer(), `${journal.target}\n`)
          .then(() => undefined)
          .catch((error) => `The active data root changed, but the legacy pointer update failed: ${String(error)}`)
  }

  async function finish(input: Journal): Promise<Result> {
    let journal = input
    const active = await current()
    if (active === journal.source) {
      await DataRoot.switchTo(Global.Path.data, journal.target)
      await syncDirectory(path.dirname(Global.Path.data))
    } else if (active !== journal.target) {
      throw new Error(`Storage relocation recovery found an unexpected active data root: ${active}`)
    }
    if (journal.phase !== "switched") journal = await writeJournal({ ...journal, phase: "switched" })
    const warning = await compatibility(journal)
    await clearJournal()
    return {
      source: journal.source,
      target: journal.target,
      files: journal.copied?.files ?? 0,
      bytes: journal.copied?.bytes ?? 0,
      ...(journal.backup ? { backup: journal.backup } : {}),
      ...(warning ? { warning } : {}),
    }
  }

  async function recover(): Promise<Result | undefined> {
    let journal = await readJournal()
    if (!journal) return
    const active = await current()
    if (active !== journal.source && active !== journal.target) {
      throw new Error(`Storage relocation recovery found an unexpected active data root: ${active}`)
    }
    if (journal.phase === "copying") {
      if (active !== journal.source) {
        throw new Error("Storage relocation recovery found an incomplete copy after the data-root switch")
      }
      await durableRemove(journal.stage, { recursive: true })
      await clearJournal()
      return
    }
    journal = await writeJournal({ ...journal, owner: await owner() })
    if (journal.phase === "ready" || journal.phase === "publishing") journal = await publish(journal)
    return finish(journal)
  }

  async function install(target: string, reset: boolean): Promise<Result> {
    if (!Global.Path.dataManaged) {
      throw new Error("Storage relocation is disabled when OPENSCIENCE_DATA_DIR explicitly owns the data root")
    }
    await using barrier = await DataRootBarrier.exclusive(120_000)
    // The exclusive barrier drains and blocks every ledger FileLease writer,
    // including an older server that can still publish pre-containment kernel
    // records. Read the now-stable ledger without entering a nested barrier;
    // a retained legacy entry quarantines relocation even after its recorded
    // leader exits and its child-owned operation marker becomes stale.
    await AuthorityProcessLedger.assertRelocationSafe()
    const recovered = await recover()
    if (recovered?.target === target) return recovered
    // Resolve the physical source only after this process owns the global
    // relocation transaction. A queued second server must snapshot the root
    // selected by the first switch, never the stale root it observed before
    // waiting for the barrier.
    const source = await current()
    if (reset && source === target) throw new Error("The default data location is already active")
    await validateTarget(source, target, reset)
    const expected = await estimate(source)
    await preflightCapacity(target, expected.bytes)
    const id = randomUUID()
    const stage = journalStage(target, id)
    const now = new Date().toISOString()
    const transactionOwner = await owner()
    let journal = await writeJournal({
      version: 1,
      id,
      mode: reset ? "reset" : "relocate",
      source,
      target,
      stage,
      phase: "copying",
      replace_empty: false,
      created_at: now,
      updated_at: now,
      owner: transactionOwner,
    })
    let stageCreated = false
    try {
      await fs.mkdir(stage, { mode: 0o700 })
      stageCreated = true
      await syncDirectory(path.dirname(stage))
    } catch (error) {
      if (stageCreated) await durableRemove(stage, { recursive: true }).catch(() => undefined)
      await clearJournal().catch(() => undefined)
      throw error
    }
    const copied = await snapshot(source, stage).catch(async (error) => {
      const cleaned = await durableRemove(stage, { recursive: true })
        .then(() => true)
        .catch(() => false)
      if (cleaned) await clearJournal().catch(() => undefined)
      throw error
    })
    const existing = await fs.lstat(target).catch(() => undefined)
    const backup =
      reset && existing ? `${target}.pre-reset-${new Date().toISOString().replaceAll(":", "-")}-${id}` : undefined
    journal = await writeJournal({ ...journal, phase: "ready", copied, backup, replace_empty: !!existing && !backup })
    journal = await publish(journal)
    return finish(journal)
  }

  export async function state(): Promise<State | undefined> {
    try {
      const journal = await readJournal()
      if (!journal) return
      return {
        id: journal.id,
        phase: journal.phase,
        source: journal.source,
        target: journal.target,
        started_at: journal.created_at,
        updated_at: journal.updated_at,
        active: await ProcessIdentity.owns(journal.owner.pid, journal.owner.identity),
      }
    } catch (error) {
      return { phase: "recovery_required", error: error instanceof Error ? error.message : String(error) }
    }
  }

  export async function relocate(raw: string): Promise<Result> {
    const target = await destination(raw)
    return install(target, false)
  }

  export async function reset(): Promise<Result> {
    const target = await destination(path.resolve(Global.Path.home, ".openscience"))
    return install(target, true)
  }
}
