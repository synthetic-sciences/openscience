import fs from "fs/promises"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import path from "node:path"
import { JsonStore } from "../util/jsonstore"

const marker = ".xdg-data-migration-v2.json"
/** Suffix for a copy in flight. Never collides with a real name, and marks
 *  leftovers from a killed process as safe to overwrite. */
const pending = ".openscience-import"
// Top-level names the import never reads or writes. `log` is disposable and is
// the one tree a still-running older instance appends to throughout the import,
// so copying it buys nothing and costs a full SHA-256 pass over tens of MB on
// the boot path.
const reserved = new Set(["bin", "log", ".xdg-data-migration-v1.json", marker])
const stores = new Set(["auth.json", "credentials.json", "mcp-auth.json"])
// Per-process scratch that must not be transplanted.
const transient = /(?:\.tmp|\.lock)$/
// A SQLite -wal/-shm is only meaningful beside the exact database it was
// written for. Landing one next to the target's own database pairs a journal
// with a database it never described; dropping it when its database IS being
// carried loses every transaction still in the log.
const journal = /(?:-wal|-shm)$/
// The artifact store is merged through SQLite instead of transplanted.
// `mergeArtifacts` opens the legacy database in place, reads valid journal
// state there, and writes clean rows into the target, so its process-local
// sidecars are the exception to the general journal rule above.
const artifactJournals = new Set([
  path.join("artifact-store", "artifacts.db-wal"),
  path.join("artifact-store", "artifacts.db-shm"),
])

export interface DataResolution {
  path: string
  migrated?: {
    source: string
    target: string
    files: number
    bytes: number
    merged: number
    artifacts: number
    /** Already in the target — settled, never retried. */
    skipped: number
    /** Unreadable or unverifiable this run — named in the marker's `pending`
     *  list so the next launch retries just these. */
    deferred: number
  }
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
      // A file can vanish between the readdir and the stat — a still-running
      // instance rotating a log, or JsonStore renaming its `.tmp` over the
      // real store. This walk runs at module scope behind a top-level await,
      // so letting ENOENT escape here does not fail the import, it stops the
      // CLI from booting at all.
      const stat = await fs.stat(full).catch(() => undefined)
      if (!stat) continue
      files.push({ path: path.relative(root, full), bytes: stat.size, mode: stat.mode & 0o777 })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** A marker's `pending` list is on-disk data a user can edit, so treat it as
 *  untrusted: only plain relative paths that stay inside the root. */
function isRelative(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false
  if (path.isAbsolute(value)) return false
  return !path.normalize(value).split(/[\\/]/).includes("..")
}

/** Re-stat named paths so a resumed import works from what is on disk now,
 *  not from what the previous run recorded. Anything gone is dropped. */
async function describe(root: string, names: string[]) {
  const files = await Promise.all(
    names.map((name) =>
      fs
        .stat(path.join(root, name))
        .then((stat) => (stat.isFile() ? { path: name, bytes: stat.size, mode: stat.mode & 0o777 } : undefined))
        .catch(() => undefined),
    ),
  )
  return files.filter((file) => file !== undefined).sort((a, b) => a.path.localeCompare(b.path))
}

/** Whether both roots seal credentials.json with the same machine key — true
 *  only when the legacy key was the one carried across, i.e. the target had
 *  none of its own. */
async function sameKey(legacy: string, target: string) {
  const [old, current] = await Promise.all(
    [legacy, target].map((root) => fs.readFile(path.join(root, "credentials.key")).catch(() => undefined)),
  )
  if (!old) return true
  return !!current && old.equals(current)
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
      // `trashed_at` has to exist on BOTH sides. A target written by an older
      // build has not been through ArtifactStore.prepare()'s ALTER TABLE yet
      // in this process, and inserting into a column it lacks fails the whole
      // merge with "no such column".
      const has = (handle: Database) =>
        (handle.query("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>).some(
          (column) => column.name === "trashed_at",
        )
      // Both the read and the write have to drop the column together: naming
      // it only in the INSERT fails just as hard as selecting it from a source
      // that lacks it.
      const trashed = has(db)
      const select = trashed ? (has(old) ? "trashed_at" : "NULL") : undefined
      const column = trashed ? "trashed_at, " : ""
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
                  ${select ? `${select},` : ""} created_at, updated_at FROM artifacts`,
          `INSERT OR IGNORE INTO artifacts
            (id, schema_version, project_id, source_key, title, kind, current_version_id, state, ${column}
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10${trashed ? ", ?11" : ""})`,
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
  // A sealed marker with nothing outstanding is the steady state for every
  // user after their first upgrade, so it has to be the cheapest path here:
  // one stat, no walk.
  const sealed = await Bun.file(path.join(target, marker))
    .json()
    .then((value) => (value && typeof value === "object" ? (value as { pending?: unknown }) : undefined))
    .catch(() => undefined)
  const outstanding = Array.isArray(sealed?.pending) ? (sealed.pending as unknown[]).filter(isRelative) : []
  if (sealed && outstanding.length === 0) return { path: target }
  if (legacy === target) return { path: target }

  // A resumed import revisits only the paths the previous run named. The rest
  // of the tree was settled then, and re-walking it to rediscover that is what
  // made a single unreadable file expensive on every launch.
  const source = sealed
    ? (await describe(legacy, outstanding)).filter((file) => !artifactJournals.has(file.path))
    : (await inventory(legacy)).filter(
        (file) =>
          !reserved.has(file.path.split(path.sep)[0]) && !transient.test(file.path) && !artifactJournals.has(file.path),
      )
  if (source.length === 0) {
    // Nothing left to fetch — the stragglers are gone from the legacy root
    // too. Clear the list so the next launch takes the one-stat path.
    if (sealed)
      await Bun.write(path.join(target, marker), `${JSON.stringify({ ...sealed, pending: [] }, null, 2)}\n`, {
        mode: 0o600,
      }).catch(() => undefined)
    return { path: target }
  }

  const occupied = (await entries(target)).some((entry) => !reserved.has(entry.name))

  // Once a single file has landed in the target this process must keep using
  // the target, whatever fails afterwards. Falling back to the legacy root at
  // that point splits a single launch across two data roots — the CLI reading
  // one while its server writes the other, which is the failure this import
  // exists to end.
  const landed = { value: false }
  const result = await (async () => {
    const copied = [] as typeof source
    // Two different reasons to not carry a file, with opposite consequences.
    // `present` means the target already has its own copy — settled forever,
    // and the whole point of never overwriting. `deferred` means this run
    // could not read or verify the source: a permission error, a file being
    // rewritten underneath us, a disk hiccup. Those go into the marker's
    // `pending` list to be retried by name, so the two must not be counted
    // together: folding them would either strand the second permanently or
    // send the next launch chasing the first.
    const present: string[] = []
    const deferred: string[] = []
    const carried = new Set<string>()
    for (const file of source) {
      if (stores.has(file.path)) continue
      const destination = path.join(target, file.path)
      const exists = await fs
        .lstat(destination)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        present.push(file.path)
        continue
      }
      // Source order is sorted, so a database sorts before its -wal/-shm and
      // `carried` is already decided by the time the journal is considered.
      if (journal.test(file.path) && !carried.has(file.path.replace(journal, ""))) {
        present.push(file.path)
        continue
      }
      // Staged beside its destination rather than in a scratch directory that
      // is later copied across. Going through a staging root meant writing
      // every byte twice and needing twice the free space before the CLI would
      // start — and on a nearly full disk the second write is what fails, so
      // the cost also bought a failure mode. Here the bytes are written once
      // and the file is linked into place.
      //
      // One unreadable file must cost that file and nothing else. Letting the
      // copy throw abandoned the entire import — credentials, session, and
      // history included — over a single chmod 000 leftover.
      const temporary = `${destination}.${process.pid}${pending}`
      const ready = await fs
        .mkdir(path.dirname(destination), { recursive: true })
        .then(() => fs.copyFile(path.join(legacy, file.path), temporary))
        .then(() => fs.chmod(temporary, file.mode))
        // Verify the copy against a fresh hash of its source, so a file being
        // rewritten underneath us is dropped alone rather than silently landing
        // half old and half new.
        .then(async () => {
          const [copy, origin] = await Promise.all([hash(temporary), hash(path.join(legacy, file.path))])
          return copy === origin
        })
        .catch(() => false)
      if (!ready) {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
        deferred.push(file.path)
        continue
      }
      // link() is the atomic create-if-absent that makes two concurrently
      // booting processes safe: the loser is told EEXIST rather than
      // overwriting the winner. Filesystems without hardlinks fall back to a
      // copy with the same exclusive semantics.
      const created = await fs
        .link(temporary, destination)
        .then(() => "created" as const)
        .catch((error: NodeJS.ErrnoException) =>
          error.code === "EEXIST"
            ? ("present" as const)
            : fs
                .copyFile(temporary, destination, constants.COPYFILE_EXCL)
                .then(() => "created" as const)
                .catch((fallback: NodeJS.ErrnoException) =>
                  fallback.code === "EEXIST" ? ("present" as const) : ("failed" as const),
                ),
        )
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      if (created !== "created") {
        ;(created === "present" ? present : deferred).push(file.path)
        continue
      }
      landed.value = true
      carried.add(file.path)
      copied.push(file)
    }

    const merged: string[] = []
    const notes: string[] = []
    for (const name of stores) {
      const old = source.find((file) => file.path === name)
      if (!old) continue
      // Entries in credentials.json are AES-256-GCM ciphertexts sealed with
      // the machine-local credentials.key. Importing them under a different
      // key produces entries the UI reports as "set" while decryptFields
      // silently drops every one — the user sees a configured GitHub token
      // and gets no GITHUB_TOKEN. Only carry them when the key came across
      // too, which is exactly when the target had none of its own.
      if (name === "credentials.json" && !(await sameKey(legacy, target))) {
        notes.push("legacy credentials.json not imported: it is sealed with a different machine key")
        continue
      }
      // A corrupt legacy store must cost that store, not the import. Left
      // unguarded this threw past the marker write, so every later boot
      // re-ran the whole import and failed at the same byte, forever.
      const outcome = await (async () => {
        const previous = await JsonStore.read(path.join(target, name))
        const legacyData = await object(path.join(legacy, name))
        if (!Object.keys(legacyData).some((key) => !(key in previous))) return 0
        const count = { value: 0 }
        await JsonStore.update(path.join(target, name), (current) => {
          count.value = Object.keys(legacyData).filter((key) => !(key in current)).length
          return { ...legacyData, ...current }
        })
        return count.value
      })().catch((error: unknown) => {
        notes.push(`legacy ${name} not imported: ${error instanceof Error ? error.message : String(error)}`)
        return 0
      })
      if (outcome > 0) {
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
    // Only on a first import. A resume is chasing a handful of named files;
    // replaying every artifact row to re-discover that they are all already
    // there would cost more than the retry it is part of.
    const artifacts = sealed
      ? 0
      : await mergeArtifacts(legacy, target).catch((error: unknown) => {
          notes.push(`legacy artifact store not imported: ${error instanceof Error ? error.message : String(error)}`)
          return 0
        })
    const bytes = copied.reduce((total, file) => total + file.bytes, 0)
    const migration = {
      source: legacy,
      target,
      files: copied.length,
      bytes,
      merged: merged.length,
      artifacts,
      skipped: present.length,
      deferred: deferred.length,
    }
    await fs.mkdir(target, { recursive: true })
    // Always seal, and carry the outstanding paths inside the marker. Leaving
    // the marker unwritten instead made every later launch re-walk and re-stat
    // the whole legacy tree — `--version` included — for as long as one file
    // stayed unreadable, which for a root-owned leftover is forever. Naming
    // the stragglers means the retry costs one stat each and the common case
    // still short-circuits on the first line of the function.
    // A resume keeps the original import's record and only updates what is
    // still outstanding — overwriting it with a retry's counts would erase the
    // one account of what actually moved.
    const record = sealed
      ? { ...sealed, pending: deferred, resumedAt: Date.now() }
      : { ...migration, migratedAt: Date.now(), pending: deferred }
    await Bun.write(path.join(target, marker), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    if (deferred.length > 0)
      notes.push(`${deferred.length} file(s) could not be read from ${legacy}; the next launch will retry them`)
    return {
      path: target,
      migrated: migration,
      warning: notes.length ? notes.join("; ") : undefined,
    } satisfies DataResolution
  })().catch((error: unknown) => {
    return {
      path: occupied || landed.value ? target : legacy,
      error: error instanceof Error ? error.message : String(error),
    } satisfies DataResolution
  })
  return result
}
