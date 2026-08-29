import fs from "fs/promises"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, existsSync } from "node:fs"
import path from "node:path"
import z from "zod"
import { JsonStore } from "../util/jsonstore"
import { SecretBox } from "../util/secret-box"

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
// Per-process scratch that must not be transplanted — including this code's
// own staging copies, so a previous root that was once a target does not have
// them imported back as if they were data.
const transient = /(?:\.tmp|\.lock|\.openscience-import)$/
/** How long a staging file must sit untouched before it counts as abandoned.
 *  Well past any real copy, so a live import's file is never reaped. */
const STALE_STAGING = 60 * 60 * 1000
/** After this, the process holding the import lease is assumed to have died. */
const STALE_LOCK = 10 * 60 * 1000
/** How long to wait for that process before importing anyway. Bounded low on
 *  purpose: the duplicated work this avoids is self-limiting — a loser skips
 *  whatever the winner has already landed, before reading a byte of it — so
 *  buying a shorter wait with a little redundancy is the right trade. Startup
 *  latency is not. */
const LEASE_WAIT = 2_000
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
/** How long a sealed import trusts itself before re-reading the previous root.
 *  Only pays a walk once per interval per machine, and only while that root
 *  still exists — which is what makes it affordable to keep watching at all. */
const RESCAN_INTERVAL = (() => {
  // `Number(x) || default` reads 0 as "unset", which quietly makes the one
  // value worth passing — rescan on every launch, for a repro or a support
  // session — mean six hours instead. It also swallows typos into the default
  // without a word.
  const configured = Number(process.env["OPENSCIENCE_LEGACY_RESCAN_MS"])
  return Number.isFinite(configured) && configured >= 0 ? configured : 6 * 60 * 60 * 1000
})()

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
  const files: Array<{ path: string; bytes: number; mode: number; mtime: number }> = []
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
      files.push({
        path: path.relative(root, full),
        bytes: stat.size,
        mode: stat.mode & 0o777,
        mtime: stat.mtimeMs,
      })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Delete staging copies an interrupted import left behind.
 *
 * Each in-flight copy is named per call, which is what keeps two concurrent
 * imports from writing the same file — but it also means a process killed
 * mid-copy leaves a name nothing will ever reuse or overwrite. Without this
 * they accumulate in the data root indefinitely, a silent leak of exactly the
 * disk this whole feature is meant to be careful with.
 *
 * Age-gated rather than unconditional: another process may be part-way through
 * writing one right now, and reaping that would turn a healthy concurrent
 * import into a deferred file.
 */
async function sweep(root: string) {
  // Skip the same top-level names the import itself never touches. Staging
  // files are only ever written where files are copied, so descending into
  // `log/` and `bin/` searches the two trees guaranteed not to contain any —
  // and `log/` is exactly the one that grows without bound.
  const stack = (await entries(root))
    .filter((entry) => entry.isDirectory() && !reserved.has(entry.name))
    .map((entry) => path.join(root, entry.name))
  stack.push(root)
  const now = Date.now()
  const seen = new Set<string>()
  while (stack.length) {
    const dir = stack.pop()
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    for (const entry of await entries(dir)) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (dir !== root) stack.push(full)
        continue
      }
      if (!entry.name.endsWith(pending)) continue
      const stat = await fs.stat(full).catch(() => undefined)
      if (!stat || now - stat.mtimeMs < STALE_STAGING) continue
      await fs.rm(full, { force: true }).catch(() => undefined)
    }
  }
}

/**
 * Best-effort exclusion so one launch does the import while its siblings wait.
 *
 * Correctness never depended on this — exclusive create and the JsonStore lease
 * already make concurrent imports safe. What they do not prevent is waste: the
 * CLI and the server it spawns would each walk and hash the whole previous root
 * at the same moment, and their artifact merges would contend on SQLite until
 * one lost to SQLITE_BUSY and quietly skipped artifacts altogether.
 *
 * Everything here degrades toward "just do the work". A lock that cannot be
 * taken, a holder that died, a wait that runs long — each falls through to an
 * unsynchronised import rather than delaying a boot. Making startup depend on a
 * lock file would be a worse failure than the duplicated effort it avoids.
 */
async function lease(target: string) {
  const lockpath = path.join(target, ".openscience-import.lock")
  await fs.mkdir(target, { recursive: true }).catch(() => undefined)
  const take = async () =>
    fs
      .open(lockpath, "wx", 0o600)
      .then((handle) => handle)
      .catch(() => undefined)

  const held = await take()
  const owned =
    held ??
    // A holder that crashed leaves the file behind forever, so an old lock is
    // assumed dead rather than trusted. Claimed by renaming it aside rather
    // than deleting it: two processes can both find the same lock expired, and
    // with `rm` both would then delete and re-create it, ending up with two
    // live holders — the exact contention the lease exists to prevent, in the
    // one situation it was added for. Only one rename of a given name wins.
    (await (async () => {
      const stat = await fs.stat(lockpath).catch(() => undefined)
      if (!stat || Date.now() - stat.mtimeMs < STALE_LOCK) return undefined
      const aside = `${lockpath}.${randomUUID()}.dead`
      const claimed = await fs
        .rename(lockpath, aside)
        .then(() => true)
        .catch(() => false)
      if (!claimed) return undefined
      await fs.rm(aside, { force: true }).catch(() => undefined)
      return take()
    })())

  if (!owned) return undefined
  await owned.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })).catch(() => undefined)
  return async () => {
    await owned.close().catch(() => undefined)
    await fs.rm(lockpath, { force: true }).catch(() => undefined)
  }
}

/** Wait for whoever holds the lease, but only while there is visibly someone
 *  to wait for, and only until the marker says the work is done. Returns
 *  whether the caller can skip the import entirely. */
async function settled(target: string) {
  const lockpath = path.join(target, ".openscience-import.lock")
  // Failing to take the lease is not proof that anyone holds it — the open can
  // fail for its own reasons, and treating that as contention meant a launch
  // sat here for the full wait with nobody on the other end. No lock file, no
  // waiting.
  if (!(await fs.stat(lockpath).catch(() => undefined))) return false
  const deadline = Date.now() + LEASE_WAIT
  while (Date.now() < deadline) {
    await Bun.sleep(25)
    const record = await Bun.file(path.join(target, marker))
      .json()
      .catch(() => undefined)
    if (record && Array.isArray(record.pending) && record.pending.length === 0) return true
    if (!(await fs.stat(lockpath).catch(() => undefined))) return false
  }
  return false
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
        .then((stat) =>
          stat.isFile() ? { path: name, bytes: stat.size, mode: stat.mode & 0o777, mtime: stat.mtimeMs } : undefined,
        )
        .catch(() => undefined),
    ),
  )
  return files.filter((file) => file !== undefined).sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Re-seal a legacy credential store under the target root's machine key.
 *
 * Every field value in credentials.json is AES-256-GCM sealed with the
 * machine-local credentials.key. When the target already had a key of its own,
 * the legacy key is not carried across, and copying the ciphertexts verbatim
 * hands the user entries the UI reports as "set" while decryptFields silently
 * drops every one — a configured GitHub token that injects no GITHUB_TOKEN.
 * Both keys are on disk here, so translate rather than discard.
 *
 * Returns undefined when there is nothing to translate or the legacy key is
 * unreadable. A field that will not open is left out: it is unrecoverable, and
 * carrying it forward would recreate exactly the silent-dud entry this exists
 * to prevent.
 */
async function reseal(legacy: string, target: string, data: Record<string, unknown>) {
  const [from, to] = await Promise.all(
    [legacy, target].map((root) => fs.readFile(path.join(root, "credentials.key")).catch(() => undefined)),
  )
  if (!from || !to) return undefined
  if (from.equals(to)) return data
  const out: Record<string, unknown> = {}
  for (const [service, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue
    const fields = (entry as { fields?: unknown }).fields
    if (!fields || typeof fields !== "object") continue
    const moved: Record<string, string> = {}
    for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof value !== "string") continue
      try {
        moved[name] = SecretBox.seal(to, SecretBox.open(from, value))
      } catch {}
    }
    if (Object.keys(moved).length > 0) out[service] = { ...entry, fields: moved }
  }
  return out
}

const mcpAuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
})
const mcpAuthClientInfo = z.object({
  clientId: z.string(),
  clientSecret: z.string().optional(),
  clientIdIssuedAt: z.number().optional(),
  clientSecretExpiresAt: z.number().optional(),
})
const mcpAuthCallback = z.discriminatedUnion("type", [
  z.object({ type: z.literal("code"), value: z.string() }),
  z.object({ type: z.literal("error"), value: z.string() }),
  z.object({ type: z.literal("cancelled") }),
])
const mcpAuthFingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const mcpAuthPlainEntry = z.object({
  tokens: mcpAuthTokens.optional(),
  clientInfo: mcpAuthClientInfo.optional(),
  codeVerifier: z.string().optional(),
  oauthState: z.string().optional(),
  oauthStartedAt: z.number().optional(),
  oauthAuthorizationUrl: z.string().url().optional(),
  oauthServerUrl: z.string().url().optional(),
  oauthAuthorityFingerprint: mcpAuthFingerprint.optional(),
  oauthAllowDisabled: z.boolean().optional(),
  oauthSettling: z.boolean().optional(),
  oauthCompletedState: z.string().optional(),
  oauthCompletedAt: z.number().optional(),
  oauthCompletedFinalized: z.boolean().optional(),
  oauthCompletedAuthorityFingerprint: mcpAuthFingerprint.optional(),
  oauthCallback: mcpAuthCallback.optional(),
  serverUrl: z.string().optional(),
  credentialAuthorityFingerprint: mcpAuthFingerprint.optional(),
})
const mcpAuthStoredEntry = z.object({
  storageVersion: z.literal(1),
  tokens: mcpAuthTokens.optional(),
  clientInfo: mcpAuthClientInfo.optional(),
  codeVerifier: z.string().optional(),
  oauthState: z.string().optional(),
  oauthStartedAt: z.number().optional(),
  // These are deliberately strings here. The URL and fingerprint constraints
  // are checked after an encrypted value has been opened.
  oauthAuthorizationUrl: z.string().optional(),
  oauthServerUrl: z.string().optional(),
  oauthAuthorityFingerprint: z.string().optional(),
  oauthAllowDisabled: z.boolean().optional(),
  oauthSettling: z.boolean().optional(),
  oauthCompletedState: z.string().optional(),
  oauthCompletedAt: z.number().optional(),
  oauthCompletedFinalized: z.boolean().optional(),
  oauthCompletedAuthorityFingerprint: z.string().optional(),
  oauthCallback: mcpAuthCallback.optional(),
  serverUrl: z.string().optional(),
  credentialAuthorityFingerprint: z.string().optional(),
})

type McpAuthRecord = Record<string, unknown>
type McpAuthLocation = { owner: McpAuthRecord; key: string }

function mcpAuthAuthorityLocations(entry: McpAuthRecord): McpAuthLocation[] {
  const result: McpAuthLocation[] = []
  const add = (owner: unknown, key: string) => {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return
    const record = owner as McpAuthRecord
    if (record[key] !== undefined) result.push({ owner: record, key })
  }
  add(entry.tokens, "accessToken")
  add(entry.tokens, "refreshToken")
  add(entry.clientInfo, "clientSecret")
  add(entry, "codeVerifier")
  add(entry, "oauthState")
  add(entry, "oauthAuthorizationUrl")
  add(entry, "oauthAuthorityFingerprint")
  add(entry, "oauthCompletedState")
  add(entry, "oauthCompletedAuthorityFingerprint")
  add(entry, "credentialAuthorityFingerprint")
  const callback = entry.oauthCallback
  if (
    callback &&
    typeof callback === "object" &&
    !Array.isArray(callback) &&
    ((callback as McpAuthRecord).type === "code" || (callback as McpAuthRecord).type === "error")
  ) {
    add(callback, "value")
  }
  return result
}

function mcpAuthMalformed(name: string, reason: string): Error {
  return new Error(`malformed MCP auth entry for ${name}: ${reason}`)
}

/** Re-key a complete MCP auth store under the target root's machine key.
 *
 * This is intentionally an all-or-nothing translation. Every entry and every
 * authority-bearing value is parsed, opened, semantically checked, re-sealed,
 * and opened again before any candidate reaches JsonStore.update. One damaged
 * sibling therefore cannot land the otherwise valid half of a store and make
 * the target's next MCP read fail. */
async function resealMcpAuth(legacy: string, target: string, data: Record<string, unknown>) {
  const prefix = "openscience-secret:v1:"
  const parsed: Array<
    | { name: string; type: "plain"; entry: z.infer<typeof mcpAuthPlainEntry> }
    | { name: string; type: "stored"; entry: z.infer<typeof mcpAuthStoredEntry> }
  > = []
  let versioned = false
  let encrypted = false

  // Complete validation happens before either key is read and before an output
  // object exists. Do not skip malformed primitives or unsupported versions:
  // merging either would leave a store McpAuth itself refuses to read.
  for (const [name, raw] of Object.entries(data)) {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "storageVersion" in raw) {
      const result = mcpAuthStoredEntry.safeParse(raw)
      if (!result.success) throw mcpAuthMalformed(name, result.error.issues[0]?.message ?? "invalid v1 envelope")
      versioned = true
      encrypted ||= mcpAuthAuthorityLocations(result.data as McpAuthRecord).some(({ owner, key }) =>
        (owner[key] as string).startsWith(prefix),
      )
      parsed.push({ name, type: "stored", entry: result.data })
      continue
    }
    const result = mcpAuthPlainEntry.safeParse(raw)
    if (!result.success) throw mcpAuthMalformed(name, result.error.issues[0]?.message ?? "invalid legacy envelope")
    parsed.push({ name, type: "plain", entry: result.data })
  }

  if (!versioned) return Object.fromEntries(parsed.map(({ name, entry }) => [name, entry]))
  const [from, to] = await Promise.all([
    encrypted ? fs.readFile(path.join(legacy, "credentials.key")).catch(() => undefined) : Promise.resolve(undefined),
    fs.readFile(path.join(target, "credentials.key")).catch(() => undefined),
  ])
  if ((encrypted && !from) || !to) return undefined

  const out: Record<string, unknown> = {}
  for (const current of parsed) {
    if (current.type === "plain") {
      out[current.name] = current.entry
      continue
    }

    const plain = structuredClone(current.entry) as McpAuthRecord
    delete plain.storageVersion
    for (const { owner, key } of mcpAuthAuthorityLocations(plain)) {
      const value = owner[key]
      if (typeof value !== "string") throw mcpAuthMalformed(current.name, `${key} is not a string`)
      owner[key] = value.startsWith(prefix) ? SecretBox.open(from!, value.slice(prefix.length)) : value
    }
    const decoded = mcpAuthPlainEntry.safeParse(plain)
    if (!decoded.success) {
      throw mcpAuthMalformed(current.name, decoded.error.issues[0]?.message ?? "invalid decrypted authority")
    }

    const candidate = { storageVersion: 1, ...structuredClone(decoded.data) } as McpAuthRecord
    for (const { owner, key } of mcpAuthAuthorityLocations(candidate)) {
      const value = owner[key]
      if (typeof value !== "string") throw mcpAuthMalformed(current.name, `${key} is not a string`)
      const sealed = SecretBox.seal(to, value)
      if (SecretBox.open(to, sealed) !== value) throw mcpAuthMalformed(current.name, `${key} did not re-seal exactly`)
      owner[key] = `${prefix}${sealed}`
    }
    const verified = mcpAuthStoredEntry.safeParse(candidate)
    if (!verified.success) {
      throw mcpAuthMalformed(current.name, verified.error.issues[0]?.message ?? "invalid translated envelope")
    }
    out[current.name] = verified.data
  }
  return out
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
      // Rows and the bytes they describe travel by different routes: metadata
      // through this merge, blob content through the file copy. A blob whose
      // file was deferred or unreadable would otherwise leave a row pointing at
      // nothing, and the artifact reading as present right up until someone
      // opens it. So the file on disk decides, and what it excludes cascades:
      // no blob, no version; no current version, no artifact.
      const store = path.join(target, "artifact-store")
      const kept = new Set(
        (old.query("SELECT sha256, path FROM blobs").all() as Array<{ sha256: string; path: string }>)
          .filter((row) => existsSync(path.join(store, row.path)))
          .map((row) => row.sha256),
      )
      const usable = new Set(
        (old.query("SELECT id, sha256 FROM versions").all() as Array<{ id: string; sha256: string }>)
          .filter((row) => kept.has(row.sha256))
          .map((row) => row.id),
      )
      db.transaction(() => {
        copy(
          "SELECT sha256, size, path, created_at FROM blobs",
          "INSERT OR IGNORE INTO blobs (sha256, size, path, created_at) VALUES (?1, ?2, ?3, ?4)",
          (row) => kept.has(row[0] as string),
        )
        copy(
          `SELECT id, schema_version, project_id, source_key, title, kind, current_version_id, state,
                  ${select ? `${select},` : ""} created_at, updated_at FROM artifacts`,
          `INSERT OR IGNORE INTO artifacts
            (id, schema_version, project_id, source_key, title, kind, current_version_id, state, ${column}
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10${trashed ? ", ?11" : ""})`,
          // current_version_id has no foreign key behind it but the UI resolves
          // it unconditionally, so an artifact whose current version did not
          // survive is worse than one that never arrived.
          (row) => usable.has(row[6] as string),
        )
        const artifacts = new Set(db.query("SELECT id FROM artifacts").values().flat())
        copy(
          `SELECT id, artifact_id, version, filename, mime_type, size, sha256, session_id, message_id, execution_id,
                  source_path, capture_quality, created_at FROM versions`,
          `INSERT OR IGNORE INTO versions
            (id, artifact_id, version, filename, mime_type, size, sha256, session_id, message_id, execution_id,
             source_path, capture_quality, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
          // Both gates matter: the artifact has to have landed, and the blob
          // the version names has to be a file that exists.
          (row) => artifacts.has(row[1] as string) && kept.has(row[6] as string),
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
  const sealed = await Bun.file(path.join(target, marker))
    .json()
    .then((value) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined))
    .catch(() => undefined)
  const outstanding = Array.isArray(sealed?.pending) ? (sealed.pending as unknown[]).filter(isRelative) : []

  // Sealing the import once and never looking back is what let a second,
  // older install keep writing to the legacy root unseen: it refreshes its
  // own session and auth there, and none of it is ever picked up. So the
  // marker is a checkpoint, not a verdict. What it must not become is a cost
  // on every command, hence the ordering here — the two cases that end the
  // function are both decided before anything walks a directory.
  const mode = await (async (): Promise<"import" | "resume" | "rescan" | "settled"> => {
    if (!sealed) return "import"
    if (outstanding.length > 0) return "resume"
    // Once the previous root is gone there is nothing left to watch, and this
    // is the steady state for anyone who has cleaned it up: one failed stat.
    const still = await fs
      .stat(legacy)
      .then((stat) => stat.isDirectory())
      .catch(() => false)
    if (!still) return "settled"
    const last = Number(sealed.checkedAt ?? sealed.migratedAt)
    if (Number.isFinite(last) && Date.now() - last < RESCAN_INTERVAL) return "settled"
    return "rescan"
  })()
  if (mode === "settled") return { path: target }
  if (legacy === target) return { path: target }

  // Past here the run is going to read the previous root, so it is worth one
  // attempt at not doing that three times over. Losing the lease is not an
  // error: wait briefly, and if the holder finishes, there is nothing left to
  // do. If it does not, fall through and import anyway.
  const release = await lease(target)
  if (!release && (await settled(target))) return { path: target }
  // Every exit below this line has to give the lease back. Doing that at the
  // individual returns is how the fresh-install path came to leak it — no
  // legacy root means no source files, which took an early return that skipped
  // the release, and from then on every launch waited the full timeout on a
  // lock nobody held. One release, in a finally, is the only version of this
  // that stays true as the function grows.
  try {
    return await run()
  } finally {
    await release?.()
  }

  async function run(): Promise<DataResolution> {
    // A resume revisits only the paths the previous run named. The rest of the
    // tree was settled then, and re-walking it to rediscover that is what made a
    // single unreadable file expensive on every launch. An import or a rescan
    // both want the whole tree — a rescan is exactly a repeat import, and it is
    // cheap precisely because everything already present is skipped by lstat
    // before it is ever read.
    //
    // A rescan is looking for what the previous root has GAINED since it was
    // last read, not for everything the target happens to be missing. Those are
    // very different sets: the target is missing anything the user deleted, and
    // copying that back means a session they removed reappears, and a provider
    // they logged out of comes back with its key. The legacy copy is never
    // deleted, so without this gate the deletion loses to the copy every
    // interval, forever. An mtime newer than the last check is precisely
    // "written by the old install since we looked", which is all this was for.
    const since = mode === "rescan" ? Number(sealed?.checkedAt ?? sealed?.migratedAt) : undefined
    const source =
      mode === "resume"
        ? (await describe(legacy, outstanding)).filter((file) => !artifactJournals.has(file.path))
        : (await inventory(legacy)).filter(
            (file) =>
              !reserved.has(file.path.split(path.sep)[0]) &&
              !transient.test(file.path) &&
              !artifactJournals.has(file.path) &&
              (since === undefined || !Number.isFinite(since) || file.mtime > since),
          )
    if (source.length === 0) {
      // Nothing to fetch — either the stragglers are gone from the legacy root
      // too, or the rescan found it empty. Record the check so the next launch
      // takes the cheap path.
      if (sealed)
        await Bun.write(
          path.join(target, marker),
          `${JSON.stringify({ ...sealed, pending: [], checkedAt: Date.now() }, null, 2)}\n`,
          { mode: 0o600 },
        ).catch(() => undefined)
      return { path: target }
    }

    // Not on a resume. That path runs on every launch for as long as one file
    // stays unreadable, and walking the whole target each time to look for
    // orphans costs more than the retry it is attached to. An orphan can wait
    // for the next full pass — the rescan comes around within the interval.
    if (mode !== "resume") await sweep(target)

    const occupied = (await entries(target)).some((entry) => !reserved.has(entry.name) && !transient.test(entry.name))

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
        // Unique per call, not just per process. Two imports running inside one
        // process — which is what a Promise.all over resolveDataDirectory is —
        // share a pid, so a pid-suffixed name has them writing the same staging
        // file and deleting it out from under each other mid-verify. Same
        // reasoning as atomicWrite in openscience/index.ts.
        const temporary = `${destination}.${process.pid}.${randomUUID()}${pending}`
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
        // Load-bearing on a rescan: `source` is filtered by mtime there, so a
        // store the old install has not rewritten is absent and this merge does
        // not run. That is what keeps a provider the user logged out of from
        // being re-added out of the previous root's copy.
        const old = source.find((file) => file.path === name)
        if (!old) continue
        // A corrupt legacy store must cost that store, not the import. Left
        // unguarded this threw past the marker write, so every later boot
        // re-ran the whole import and failed at the same byte, forever.
        const outcome = await (async () => {
          const previous = await JsonStore.read(path.join(target, name))
          const raw = await object(path.join(legacy, name))
          // Credentials are the one store whose values are not portable on
          // their own; everything else is plaintext JSON that means the same
          // thing in either root.
          const legacyData =
            name === "credentials.json"
              ? await reseal(legacy, target, raw)
              : name === "mcp-auth.json"
                ? await resealMcpAuth(legacy, target, raw)
                : raw
          if (!legacyData) {
            notes.push(`legacy ${name} not imported: its machine key is unreadable`)
            if (!deferred.includes(name)) deferred.push(name)
            return 0
          }
          if (!Object.keys(legacyData).some((key) => !(key in previous))) return 0
          const count = { value: 0 }
          await JsonStore.update(path.join(target, name), (current) => {
            count.value = Object.keys(legacyData).filter((key) => !(key in current)).length
            return { ...legacyData, ...current }
          })
          return count.value
        })().catch((error: unknown) => {
          notes.push(`legacy ${name} not imported: ${error instanceof Error ? error.message : String(error)}`)
          // An unreadable encrypted MCP entry may become recoverable after the
          // operator restores the matching machine key/store. Keep the exact
          // store pending so a completed migration marker does not strand all
          // otherwise valid entries behind the source-mtime rescan filter.
          if (name === "mcp-auth.json" && !deferred.includes(name)) deferred.push(name)
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
      // Skipped only on a resume, which is chasing a handful of named files:
      // replaying every artifact row to rediscover that they are all already
      // there would cost more than the retry it is part of. A rescan does run
      // it — new artifacts written to the previous root are exactly what it is
      // looking for.
      const artifacts =
        mode === "resume"
          ? 0
          : await mergeArtifacts(legacy, target).catch((error: unknown) => {
              notes.push(
                `legacy artifact store not imported: ${error instanceof Error ? error.message : String(error)}`,
              )
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
      // A later pass keeps the original import's record and only updates what is
      // still outstanding — overwriting it with a retry's counts would erase the
      // one account of what actually moved. `checkedAt` is what paces the rescan,
      // so it is stamped on every pass, including the first.
      // A resume that actually carried something leaves `checkedAt` alone, so
      // the next launch rescans instead of waiting out another full interval.
      // The artifact merge is skipped on a resume, so a blob whose bytes just
      // arrived has no rows describing it until that rescan runs — and while
      // that is true, `doctor` reports nothing outstanding and `--prune-legacy`
      // would delete the only copy of those rows.
      const resumed = mode === "resume" && copied.length > 0
      const record = sealed
        ? { ...sealed, pending: deferred, ...(resumed ? {} : { checkedAt: Date.now() }) }
        : { ...migration, migratedAt: Date.now(), checkedAt: Date.now(), pending: deferred }
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
}
