import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { AuthorityProcessLedger } from "@/project/authority-process"
import { DataRoot } from "./data-root"
import { DataRootBarrier } from "./data-root-barrier"

export namespace DataRelocation {
  export interface Result {
    source: string
    target: string
    files: number
    bytes: number
    backup?: string
    warning?: string
  }

  const pointer = () => path.join(Global.Path.config, "data-location")
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

  async function atomicWrite(filepath: string, content: string) {
    const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      await fs.rename(temporary, filepath)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
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
    const stack: Array<{ source: string; destination: string; relative: string }> = [
      { source, destination, relative: "" },
    ]
    while (stack.length) {
      const current = stack.pop()
      if (!current) continue
      await fs.mkdir(current.destination, { recursive: true })
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
    }
    await verifyArtifacts(destination)
    return { files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0) }
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
    // Resolve the physical source only after this process owns the global
    // relocation transaction. A queued second server must snapshot the root
    // selected by the first switch, never the stale root it observed before
    // waiting for the barrier.
    const source = await current()
    if (reset && source === target) throw new Error("The default data location is already active")
    await validateTarget(source, target, reset)
    const stage = path.join(path.dirname(target), `.${path.basename(target)}.openscience-${randomUUID()}`)
    const copied = await snapshot(source, stage).catch(async (error) => {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
      throw error
    })
    const existing = await fs.lstat(target).catch(() => undefined)
    const backup =
      reset && existing ? `${target}.pre-reset-${new Date().toISOString().replaceAll(":", "-")}` : undefined
    if (backup) await fs.rename(target, backup)
    if (existing && !backup) await fs.rmdir(target)
    await fs.rename(stage, target).catch(async (error) => {
      if (backup) await fs.rename(backup, target).catch(() => undefined)
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
      throw error
    })

    await DataRoot.switchTo(Global.Path.data, target)
    const compatibility = reset
      ? await fs
          .rm(pointer(), { force: true })
          .then(() => undefined)
          .catch((error) => `The active data root changed, but the legacy pointer cleanup failed: ${String(error)}`)
      : await atomicWrite(pointer(), `${target}\n`)
          .then(() => undefined)
          .catch((error) => `The active data root changed, but the legacy pointer update failed: ${String(error)}`)
    return {
      source,
      target,
      ...copied,
      ...(backup ? { backup } : {}),
      ...(compatibility ? { warning: compatibility } : {}),
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
