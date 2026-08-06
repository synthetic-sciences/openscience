import fs from "fs/promises"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import path from "node:path"
import { JsonStore } from "../util/jsonstore"

const marker = ".xdg-data-migration-v2.json"
// Top-level names the import never reads or writes. `log` is disposable and is
// the one tree a still-running older instance appends to throughout the import,
// so copying it buys nothing and costs a full SHA-256 pass over tens of MB on
// the boot path.
const reserved = new Set(["bin", "log", ".xdg-data-migration-v1.json", marker])
const stores = new Set(["auth.json", "credentials.json", "mcp-auth.json"])
// Per-process scratch that must not be transplanted. A SQLite -wal/-shm belongs
// to the legacy database specifically; landing one beside the target's own
// artifacts.db pairs a journal with a database it never described.
const transient = /(?:-wal|-shm|\.tmp|\.lock)$/

export interface DataResolution {
  path: string
  migrated?: {
    source: string
    target: string
    files: number
    bytes: number
    merged: number
    artifacts: number
    skipped: number
  }
  conflict?: { legacy: string; current: string }
  warning?: string
  error?: string
}

async function entries(root: string) {
  return fs.readdir(root, { withFileTypes: true }).catch(() => [])
}

async function hash(file: string) {
  const value = createHash("sha256")
  for await (const chunk of createReadStream(file)) value.update(chunk)
  return value.digest("hex")
}

async function inventory(root: string) {
  const stack = [root]
  const files: Array<{ path: string; bytes: number; mode: number }> = []
  while (stack.length) {
    const dir = stack.pop()
    if (!dir) continue
    for (const entry of await entries(dir)) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(full)
      files.push({ path: path.relative(root, full), bytes: stat.size, mode: stat.mode & 0o777 })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function object(file: string) {
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} is not a JSON object`)
  return value as Record<string, unknown>
}

async function mergeArtifacts(legacy: string, target: string) {
  const source = path.join(legacy, "artifact-store", "artifacts.db")
  const destination = path.join(target, "artifact-store", "artifacts.db")
  const available = await Promise.all(
    [source, destination].map((file) =>
      fs
        .stat(file)
        .then((stat) => stat.isFile())
        .catch(() => false),
    ),
  )
  if (!available.every(Boolean)) return 0

  const db = new Database(destination)
  const old = new Database(source, { readonly: true })
  return Promise.resolve()
    .then(() => {
      db.exec("PRAGMA foreign_keys = ON")
      db.exec("PRAGMA busy_timeout = 5000")
      const columns = old.query("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>
      const trashed = columns.some((column) => column.name === "trashed_at") ? "trashed_at" : "NULL"
      const before = db.query("SELECT count(*) AS value FROM main.artifacts").get() as { value: number }
      const copy = (select: string, insert: string, keep?: (row: SQLQueryBindings[]) => boolean) => {
        const statement = db.query<unknown, SQLQueryBindings[]>(insert)
        for (const row of old.query(select).values() as SQLQueryBindings[][]) {
          if (keep && !keep(row)) continue
          statement.run(...row)
        }
      }
      db.transaction(() => {
        copy(
          "SELECT sha256, size, path, created_at FROM blobs",
          "INSERT OR IGNORE INTO blobs (sha256, size, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        copy(
          `SELECT id, schema_version, project_id, source_key, title, kind, current_version_id, state,
                  ${trashed}, created_at, updated_at FROM artifacts`,
          `INSERT OR IGNORE INTO artifacts
            (id, schema_version, project_id, source_key, title, kind, current_version_id, state, trashed_at,
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        const artifacts = new Set(db.query("SELECT id FROM artifacts").values().flat())
        copy(
          `SELECT id, artifact_id, version, filename, mime_type, size, sha256, session_id, message_id, execution_id,
                  source_path, capture_quality, created_at FROM versions`,
          `INSERT OR IGNORE INTO versions
            (id, artifact_id, version, filename, mime_type, size, sha256, session_id, message_id, execution_id,
             source_path, capture_quality, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
          (row) => artifacts.has(row[1] as string),
        )
        const versions = new Set(db.query("SELECT id FROM versions").values().flat())
        copy(
          `SELECT id, artifact_version_id, command, code, status, stdout, stderr, model, provider, effort, source,
                  permission_snapshot, inputs, capture_quality, files, environment, created_at FROM executions`,
          `INSERT OR IGNORE INTO executions
            (id, artifact_version_id, command, code, status, stdout, stderr, model, provider, effort, source,
             permission_snapshot, inputs, capture_quality, files, environment, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
          (row) => versions.has(row[1] as string),
        )
      })()
      const after = db.query("SELECT count(*) AS value FROM main.artifacts").get() as { value: number }
      return after.value - before.value
    })
    .then(
      (result) => {
        old.close()
        db.close()
        return result
      },
      (error) => {
        old.close()
        db.close()
        throw error
      },
    )
}

export async function resolveDataDirectory(input: {
  home: string
  legacy: string
  explicit?: string
  pointer?: string
}): Promise<DataResolution> {
  if (input.explicit) return { path: path.resolve(input.explicit) }
  if (input.pointer) return { path: path.resolve(input.pointer) }

  const target = path.join(path.resolve(input.home), ".openscience")
  const legacy = path.resolve(input.legacy)
  const migrated = await fs
    .stat(path.join(target, marker))
    .then((stat) => stat.isFile())
    .catch(() => false)
  if (migrated) return { path: target }
  if (legacy === target) return { path: target }

  const source = (await inventory(legacy)).filter(
    (file) => !reserved.has(file.path.split(path.sep)[0]) && !transient.test(file.path),
  )
  if (source.length === 0) return { path: target }

  const occupied = (await entries(target)).some((entry) => !reserved.has(entry.name))

  // Once a single file has landed in the target this process must keep using
  // the target, whatever fails afterwards. Falling back to the legacy root at
  // that point splits a single launch across two data roots — the CLI reading
  // one while its server writes the other, which is the failure this import
  // exists to end.
  const landed = { value: false }
  const stage = await fs.mkdtemp(path.join(path.resolve(input.home), ".openscience-migrate-"))
  const result = await (async () => {
    const staged = [] as typeof source
    const skipped: string[] = []
    for (const file of source) {
      if (stores.has(file.path)) continue
      const destination = path.join(target, file.path)
      const exists = await fs
        .lstat(destination)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        skipped.push(file.path)
        continue
      }
      const temporary = path.join(stage, file.path)
      await fs.mkdir(path.dirname(temporary), { recursive: true })
      await fs.copyFile(path.join(legacy, file.path), temporary)
      await fs.chmod(temporary, file.mode)
      staged.push(file)
    }

    // Verify each copy against a fresh hash of its source and drop only the
    // files that disagree. Comparing whole-tree manifests instead meant one
    // file changing mid-copy — a session an already-running instance was
    // still writing — discarded the entire import, credentials and history
    // included, and left the user signed out for the sake of one stale byte.
    const verified = [] as typeof staged
    for (const file of staged) {
      const [copy, origin] = await Promise.all([
        hash(path.join(stage, file.path)).catch(() => undefined),
        hash(path.join(legacy, file.path)).catch(() => undefined),
      ])
      if (!copy || copy !== origin) {
        skipped.push(file.path)
        continue
      }
      verified.push(file)
    }

    const copied = [] as typeof staged
    for (const file of verified) {
      const destination = path.join(target, file.path)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const created = await fs
        .copyFile(path.join(stage, file.path), destination, constants.COPYFILE_EXCL)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return false
          throw error
        })
      if (!created) {
        skipped.push(file.path)
        continue
      }
      await fs.chmod(destination, file.mode)
      landed.value = true
      copied.push(file)
    }

    const merged: string[] = []
    for (const name of stores) {
      const old = source.find((file) => file.path === name)
      if (!old) continue
      const previous = await JsonStore.read(path.join(target, name))
      const legacyData = await object(path.join(legacy, name))
      if (!Object.keys(legacyData).some((key) => !(key in previous))) continue
      const count = { value: 0 }
      await JsonStore.update(path.join(target, name), (current) => {
        count.value = Object.keys(legacyData).filter((key) => !(key in current)).length
        return { ...legacyData, ...current }
      })
      if (count.value > 0) {
        landed.value = true
        merged.push(name)
      }
    }

    // Artifacts are the one part of the import that reads a foreign file
    // format, so they are the one part that can fail on data this code never
    // wrote: a truncated or half-written legacy artifacts.db raises "file is
    // not a database". Recovering a user's credentials and history must not
    // hinge on that — record the reason and finish the import without it,
    // rather than throwing away everything already verified.
    const outcome = await mergeArtifacts(legacy, target).then(
      (count) => ({ count, warning: undefined as string | undefined }),
      (error: unknown) => ({
        count: 0,
        warning: `legacy artifact store not imported: ${error instanceof Error ? error.message : String(error)}`,
      }),
    )
    const artifacts = outcome.count
    const imported = copied.length + merged.length + (artifacts > 0 ? 1 : 0)
    const bytes = [...copied, ...source.filter((file) => merged.includes(file.path))].reduce(
      (total, file) => total + file.bytes,
      0,
    )
    const migration = {
      source: legacy,
      target,
      files: imported,
      bytes,
      merged: merged.length,
      artifacts,
      skipped: skipped.length,
    }
    await fs.mkdir(target, { recursive: true })
    await Bun.write(
      path.join(target, marker),
      `${JSON.stringify({ ...migration, migratedAt: Date.now() }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    )
    return { path: target, migrated: migration, warning: outcome.warning } satisfies DataResolution
  })().catch((error: unknown) => {
    return {
      path: occupied || landed.value ? target : legacy,
      error: error instanceof Error ? error.message : String(error),
    } satisfies DataResolution
  })
  await fs.rm(stage, { recursive: true, force: true })
  return result
}
