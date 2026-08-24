import { Database } from "bun:sqlite"
import type { BunFile } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { Cleanup } from "@/util/cleanup"
import { FileLease } from "@/util/file-lease"
import { Lock } from "@/util/lock"
import { OutboundTelemetry } from "@/telemetry/outbound"

export namespace ArtifactStore {
  export const MAX_VERSION_BYTES = 1024 * 1024 * 1024
  export const FREE_SPACE_RESERVE_BYTES = 1024 * 1024 * 1024
  export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

  export const CaptureQuality = z.enum(["exact", "declared", "partial", "unknown"])
  export type CaptureQuality = z.infer<typeof CaptureQuality>

  export const Execution = z.object({
    id: z.string(),
    artifactVersionID: z.string(),
    command: z.string().optional(),
    code: z.string().optional(),
    status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    effort: z.string().optional(),
    source: z.string().optional(),
    permissionSnapshot: z.record(z.string(), z.unknown()).optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    captureQuality: CaptureQuality,
    files: z.array(z.object({ path: z.string(), sha256: z.string(), size: z.number().int().nonnegative() })),
    environment: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.number().int().positive(),
  })
  export type Execution = z.infer<typeof Execution>

  export const Version = z.object({
    id: z.string(),
    artifactID: z.string(),
    version: z.number().int().positive(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sessionID: z.string(),
    messageID: z.string().optional(),
    executionID: z.string().optional(),
    sourcePath: z.string(),
    captureQuality: CaptureQuality,
    createdAt: z.number().int().positive(),
  })
  export type Version = z.infer<typeof Version>

  export const Artifact = z.object({
    schemaVersion: z.literal(1),
    id: z.string(),
    projectID: z.string(),
    title: z.string(),
    kind: z.string(),
    currentVersionID: z.string(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
    state: z.enum(["active", "trash"]),
    trashedAt: z.number().int().positive().optional(),
    versionCount: z.number().int().positive(),
    current: Version,
  })
  export type Artifact = z.infer<typeof Artifact>

  export const Detail = Artifact.extend({
    versions: Version.array(),
    execution: Execution.optional(),
  })
  export type Detail = z.infer<typeof Detail>

  export interface SaveInput {
    projectID: string
    sessionID: string
    sourcePath: string
    filename: string
    kind: string
    content: {
      readonly size: number
      readonly type?: string
      stream(): ReadableStream<Uint8Array>
    }
    title?: string
    mimeType?: string
    messageID?: string
    captureQuality?: CaptureQuality
    execution?: Omit<Execution, "id" | "artifactVersionID" | "createdAt">
  }

  export class LimitError extends Error {
    constructor(readonly size: number) {
      super(`Artifact version is ${size} bytes; the limit is ${MAX_VERSION_BYTES} bytes`)
    }
  }

  export class CapacityError extends Error {
    constructor(
      readonly required: number,
      readonly available: number,
    ) {
      super(`Artifact save needs ${required} bytes free; ${available} bytes are available`)
    }
  }

  const root = path.join(Global.Path.data, "artifact-store")
  const blobs = path.join(root, "blobs")
  const partials = path.join(root, "partial")
  const database = path.join(root, "artifacts.db")
  const lock = path.join(root, ".write")
  const scanned = { at: 0 }

  type VersionRow = {
    id: string
    artifact_id: string
    version: number
    filename: string
    mime_type: string
    size: number
    sha256: string
    session_id: string
    message_id: string | null
    execution_id: string | null
    source_path: string
    capture_quality: CaptureQuality
    created_at: number
  }

  type ArtifactRow = {
    artifact_record_id: string
    project_id: string
    title: string
    kind: string
    current_version_id: string
    created_at: number
    updated_at: number
    state: "active" | "trash"
    trashed_at: number | null
    version_count: number
  } & VersionRow

  type ExecutionRow = {
    id: string
    artifact_version_id: string
    command: string | null
    code: string | null
    status: "succeeded" | "failed" | "cancelled" | "unknown"
    stdout: string | null
    stderr: string | null
    model: string | null
    provider: string | null
    effort: string | null
    source: string | null
    permission_snapshot: string | null
    inputs: string | null
    capture_quality: CaptureQuality
    files: string
    environment: string | null
    created_at: number
  }

  export function reviewTargetID(versionID: string, sha256: string) {
    return `artifact-version:${versionID}:${sha256.slice(0, 16)}`
  }

  const schema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO store_meta (key, value) VALUES ('schema_version', '1');
    CREATE TABLE IF NOT EXISTS blobs (
      sha256 TEXT PRIMARY KEY,
      size INTEGER NOT NULL CHECK(size >= 0),
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      project_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      current_version_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'trash')),
      trashed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, source_key)
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version > 0),
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size >= 0),
      sha256 TEXT NOT NULL REFERENCES blobs(sha256),
      session_id TEXT NOT NULL,
      message_id TEXT,
      execution_id TEXT,
      source_path TEXT NOT NULL,
      capture_quality TEXT NOT NULL CHECK(capture_quality IN ('exact', 'declared', 'partial', 'unknown')),
      created_at INTEGER NOT NULL,
      UNIQUE(artifact_id, version)
    );
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      artifact_version_id TEXT NOT NULL UNIQUE REFERENCES versions(id) ON DELETE CASCADE,
      command TEXT,
      code TEXT,
      status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'cancelled', 'unknown')),
      stdout TEXT,
      stderr TEXT,
      model TEXT,
      provider TEXT,
      effort TEXT,
      source TEXT,
      permission_snapshot TEXT,
      inputs TEXT,
      capture_quality TEXT NOT NULL CHECK(capture_quality IN ('exact', 'declared', 'partial', 'unknown')),
      files TEXT NOT NULL,
      environment TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS artifacts_project_updated ON artifacts(project_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS versions_artifact_version ON versions(artifact_id, version DESC);
  `

  async function prepare() {
    await Promise.all([fs.mkdir(blobs, { recursive: true }), fs.mkdir(partials, { recursive: true })])
    const db = new Database(database, { create: true })
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = FULL")
    db.exec(schema)
    const columns = db.query("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "trashed_at")) {
      db.exec("ALTER TABLE artifacts ADD COLUMN trashed_at INTEGER")
    }
    db.query("UPDATE store_meta SET value = '2' WHERE key = 'schema_version'").run()
    return db
  }

  function version(row: VersionRow): Version {
    return {
      id: row.id,
      artifactID: row.artifact_id,
      version: row.version,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      sha256: row.sha256,
      sessionID: row.session_id,
      ...(row.message_id ? { messageID: row.message_id } : {}),
      ...(row.execution_id ? { executionID: row.execution_id } : {}),
      sourcePath: row.source_path,
      captureQuality: row.capture_quality,
      createdAt: row.created_at,
    }
  }

  function artifact(row: ArtifactRow): Artifact {
    return {
      schemaVersion: 1,
      id: row.artifact_record_id,
      projectID: row.project_id,
      title: row.title,
      kind: row.kind,
      currentVersionID: row.current_version_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: row.state,
      ...(row.trashed_at ? { trashedAt: row.trashed_at } : {}),
      versionCount: row.version_count,
      current: version(row),
    }
  }

  function parse(value: string | null) {
    if (!value) return
    return JSON.parse(value) as Record<string, unknown>
  }

  function execution(row: ExecutionRow): Execution {
    return {
      id: row.id,
      artifactVersionID: row.artifact_version_id,
      ...(row.command ? { command: row.command } : {}),
      ...(row.code ? { code: row.code } : {}),
      status: row.status,
      ...(row.stdout ? { stdout: row.stdout } : {}),
      ...(row.stderr ? { stderr: row.stderr } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.permission_snapshot ? { permissionSnapshot: parse(row.permission_snapshot) } : {}),
      ...(row.inputs ? { inputs: parse(row.inputs) } : {}),
      captureQuality: row.capture_quality,
      files: JSON.parse(row.files) as Execution["files"],
      ...(row.environment ? { environment: parse(row.environment) } : {}),
      createdAt: row.created_at,
    }
  }

  const select = `
    SELECT
      a.id AS artifact_record_id, a.project_id, a.title, a.kind, a.current_version_id,
      a.created_at, a.updated_at, a.state, a.trashed_at,
      (SELECT count(*) FROM versions all_versions WHERE all_versions.artifact_id = a.id) AS version_count,
      v.id, v.artifact_id, v.version, v.filename, v.mime_type, v.size, v.sha256, v.session_id,
      v.message_id, v.execution_id, v.source_path, v.capture_quality, v.created_at
    FROM artifacts a
    JOIN versions v ON v.id = a.current_version_id
  `

  async function space(size: number) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid artifact byte length: ${size}`)
    if (size > MAX_VERSION_BYTES) throw new LimitError(size)
    const stat = await fs.statfs(root)
    const available = Number(stat.bavail) * Number(stat.bsize)
    const required = size + FREE_SPACE_RESERVE_BYTES
    if (available < required) throw new CapacityError(required, available)
  }

  async function stage(content: SaveInput["content"]) {
    await prepare().then((db) => db.close())
    await space(content.size)
    const file = path.join(partials, `${crypto.randomUUID()}.partial`)
    const handle = await fs.open(file, "wx")
    const hasher = new Bun.CryptoHasher("sha256")
    const reader = content.stream().getReader()
    const total = { value: 0 }
    const write = async () => {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        total.value += item.value.byteLength
        if (total.value > content.size || total.value > MAX_VERSION_BYTES) {
          throw new Error(`Artifact stream exceeded its declared ${content.size}-byte length`)
        }
        hasher.update(item.value)
        const offset = { value: 0 }
        while (offset.value < item.value.byteLength) {
          const result = await handle.write(item.value, offset.value, item.value.byteLength - offset.value, null)
          if (!result.bytesWritten) throw new Error("Artifact staging write made no progress")
          offset.value += result.bytesWritten
        }
      }
      if (total.value !== content.size) {
        throw new Error(`Artifact stream ended at ${total.value} bytes; expected ${content.size}`)
      }
    }
    const state = { closed: false }
    try {
      await write()
      await handle.sync()
      await handle.close()
      state.closed = true
      return { file, sha256: hasher.digest("hex"), size: total.value }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined)
      if (!state.closed) await handle.close().catch(() => undefined)
      await fs.rm(file, { force: true })
      throw error
    } finally {
      reader.releaseLock()
    }
  }

  function blob(sha256: string) {
    return path.join(blobs, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  }

  async function physicalBlobs() {
    const output: string[] = []
    const count = { value: 0 }
    const read = async function* (directory: string) {
      const entries = await fs.opendir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return
        throw error
      })
      if (!entries) return
      for await (const entry of entries) {
        count.value++
        if (count.value > 200_000) throw new Error("Artifact blob scan exceeded 200000 entries")
        yield entry
      }
    }
    for await (const first of read(blobs)) {
      const firstPath = path.join(blobs, first.name)
      if (first.isSymbolicLink()) {
        output.push(path.relative(root, firstPath))
        continue
      }
      if (!first.isDirectory()) continue
      for await (const second of read(firstPath)) {
        const secondPath = path.join(firstPath, second.name)
        if (second.isSymbolicLink()) {
          output.push(path.relative(root, secondPath))
          continue
        }
        if (!second.isDirectory()) continue
        for await (const file of read(secondPath)) {
          if (!file.isFile() && !file.isSymbolicLink()) continue
          output.push(path.relative(root, path.join(secondPath, file.name)))
        }
      }
    }
    return output
  }

  async function digest(content: BunFile) {
    const hasher = new Bun.CryptoHasher("sha256")
    const reader = content.stream().getReader()
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) return hasher.digest("hex")
        hasher.update(item.value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  function rows(db: Database, projectID: string, artifactID?: string, state: "active" | "trash" = "active") {
    const suffix = artifactID
      ? " WHERE a.project_id = ?1 AND a.id = ?2"
      : " WHERE a.project_id = ?1 AND a.state = ?2 ORDER BY a.updated_at DESC, a.id"
    return db
      .query(select + suffix)
      .all(...(artifactID ? [projectID, artifactID] : [projectID, state])) as ArtifactRow[]
  }

  export async function save(input: SaveInput): Promise<Artifact> {
    using _ = await Lock.write(lock)
    await using lease = await FileLease.acquire(lock)
    // Capacity is a store-wide invariant. Serialize the reservation check and
    // stream itself so concurrent large saves cannot each observe the same
    // free bytes and collectively consume the safety reserve.
    const staged = await stage(input.content)
    const db = await prepare()
    const target = blob(staged.sha256)
    const now = Date.now()
    const artifactID = `art_${crypto.randomUUID()}`
    const versionID = `ver_${crypto.randomUUID()}`
    const executionID = input.execution ? `exe_${crypto.randomUUID()}` : undefined
    const source = input.sourcePath.replaceAll("\\", "/")
    const relative = path.relative(root, target)
    const state = {
      transaction: false,
      committed: false,
      installed: false,
      identity: undefined as { dev: number; ino: number } | undefined,
    }
    const cleanup = async () => {
      if (!state.installed || state.committed || !state.identity) return
      const current = await fs.lstat(target).catch(() => undefined)
      if (!current || current.dev !== state.identity.dev || current.ino !== state.identity.ino) return
      await fs.rm(target, { force: true })
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      const published = await fs.link(staged.file, target).then(
        () => true,
        async (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return false
          await fs.rm(staged.file, { force: true })
          throw error
        },
      )
      if (!published) {
        const prior = await fs.lstat(target).catch(() => undefined)
        const valid =
          !!prior?.isFile() &&
          !prior.isSymbolicLink() &&
          prior.size === staged.size &&
          (await digest(Bun.file(target))) === staged.sha256
        if (valid) await fs.rm(staged.file, { force: true })
        if (!valid) {
          await fs.rename(staged.file, target)
          state.installed = true
        }
      } else {
        state.installed = true
        await fs.rm(staged.file, { force: true })
      }
      const stored = await fs.lstat(target)
      if (state.installed) state.identity = { dev: stored.dev, ino: stored.ino }
      if (
        !stored.isFile() ||
        stored.isSymbolicLink() ||
        stored.size !== staged.size ||
        (await digest(Bun.file(target))) !== staged.sha256
      ) {
        throw new Error(`Artifact blob ${staged.sha256} failed its size integrity check`)
      }

      db.exec("BEGIN IMMEDIATE")
      state.transaction = true
      const existing = db
        .query("SELECT id FROM artifacts WHERE project_id = ?1 AND source_key = ?2")
        .get(input.projectID, source) as { id: string } | null
      const id = existing?.id ?? artifactID
      const count = db
        .query("SELECT coalesce(max(version), 0) AS value FROM versions WHERE artifact_id = ?1")
        .get(id) as {
        value: number
      }
      const number = count.value + 1
      db.query("INSERT OR IGNORE INTO blobs (sha256, size, path, created_at) VALUES (?1, ?2, ?3, ?4)").run(
        staged.sha256,
        staged.size,
        relative,
        now,
      )
      const record = db.query("SELECT size, path FROM blobs WHERE sha256 = ?1").get(staged.sha256) as {
        size: number
        path: string
      }
      if (record.size !== staged.size || record.path !== relative) {
        throw new Error(`Artifact blob ${staged.sha256} conflicts with the stored integrity record`)
      }
      if (!existing) {
        db.query(
          `INSERT INTO artifacts
            (id, schema_version, project_id, source_key, title, kind, current_version_id, state, created_at, updated_at)
           VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)`,
        ).run(id, input.projectID, source, input.title ?? input.filename, input.kind, versionID, now)
      }
      db.query(
        `INSERT INTO versions
          (id, artifact_id, version, filename, mime_type, size, sha256, session_id, message_id, execution_id,
           source_path, capture_quality, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).run(
        versionID,
        id,
        number,
        input.filename,
        input.mimeType || input.content.type || "application/octet-stream",
        staged.size,
        staged.sha256,
        input.sessionID,
        input.messageID ?? null,
        executionID ?? null,
        source,
        input.captureQuality ?? "declared",
        now,
      )
      if (input.execution && executionID) {
        db.query(
          `INSERT INTO executions
            (id, artifact_version_id, command, code, status, stdout, stderr, model, provider, effort, source,
             permission_snapshot, inputs, capture_quality, files, environment, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
        ).run(
          executionID,
          versionID,
          input.execution.command ?? null,
          input.execution.code ?? null,
          input.execution.status,
          input.execution.stdout ?? null,
          input.execution.stderr ?? null,
          input.execution.model ?? null,
          input.execution.provider ?? null,
          input.execution.effort ?? null,
          input.execution.source ?? null,
          input.execution.permissionSnapshot ? JSON.stringify(input.execution.permissionSnapshot) : null,
          input.execution.inputs ? JSON.stringify(input.execution.inputs) : null,
          input.execution.captureQuality,
          JSON.stringify(input.execution.files),
          input.execution.environment ? JSON.stringify(input.execution.environment) : null,
          now,
        )
      }
      db.query(
        `UPDATE artifacts
         SET title = ?1, kind = ?2, current_version_id = ?3, state = 'active', trashed_at = NULL, updated_at = ?4
         WHERE id = ?5`,
      ).run(input.title ?? input.filename, input.kind, versionID, now, id)
      db.exec("COMMIT")
      state.committed = true

      const row = rows(db, input.projectID, id)[0]
      if (!row) throw new Error(`Artifact ${id} was not saved`)
      const saved = artifact(row)
      void OutboundTelemetry.artifact({
        sessionID: input.sessionID,
        messageID: input.messageID,
        artifact: saved,
        execution: input.execution,
      }).catch(() => undefined)
      return saved
    } catch (cause) {
      const rollback = (() => {
        if (!state.transaction || state.committed) return
        try {
          db.exec("ROLLBACK")
        } catch (error) {
          return error
        }
      })()
      await fs.rm(staged.file, { force: true })
      await cleanup()
      if (rollback) throw new AggregateError([cause, rollback], "Artifact save and rollback both failed")
      throw cause
    } finally {
      db.close()
    }
  }

  export async function list(projectID: string, state: "active" | "trash" = "active"): Promise<Artifact[]> {
    await sweep()
    const db = await prepare()
    const result = rows(db, projectID, undefined, state).map(artifact)
    db.close()
    return result
  }

  export async function rename(projectID: string, artifactID: string, title: string): Promise<Artifact | undefined> {
    using _ = await Lock.write(lock)
    await using lease = await FileLease.acquire(lock)
    const db = await prepare()
    db.query("UPDATE artifacts SET title = ?1, updated_at = ?2 WHERE project_id = ?3 AND id = ?4").run(
      title,
      Date.now(),
      projectID,
      artifactID,
    )
    const row = rows(db, projectID, artifactID)[0]
    db.close()
    return row ? artifact(row) : undefined
  }

  export async function trash(projectID: string, artifactID: string, now = Date.now()): Promise<Artifact | undefined> {
    using _ = await Lock.write(lock)
    await using lease = await FileLease.acquire(lock)
    const db = await prepare()
    db.query(
      "UPDATE artifacts SET state = 'trash', trashed_at = ?1, updated_at = ?1 WHERE project_id = ?2 AND id = ?3",
    ).run(now, projectID, artifactID)
    const row = rows(db, projectID, artifactID)[0]
    db.close()
    return row ? artifact(row) : undefined
  }

  export async function restore(projectID: string, artifactID: string): Promise<Artifact | undefined> {
    using _ = await Lock.write(lock)
    await using lease = await FileLease.acquire(lock)
    const db = await prepare()
    db.query(
      "UPDATE artifacts SET state = 'active', trashed_at = NULL, updated_at = ?1 WHERE project_id = ?2 AND id = ?3",
    ).run(Date.now(), projectID, artifactID)
    const row = rows(db, projectID, artifactID)[0]
    db.close()
    return row ? artifact(row) : undefined
  }

  export async function sweep(now = Date.now()) {
    using _ = await Lock.write(lock)
    await using lease = await FileLease.acquire(lock)
    const db = await prepare()
    const cutoff = now - TRASH_RETENTION_MS
    const orphaned = (() => {
      try {
        db.exec("BEGIN IMMEDIATE")
        const stale = db
          .query("SELECT id FROM artifacts WHERE state = 'trash' AND trashed_at <= ?1")
          .all(cutoff) as Array<{ id: string }>
        const remove = db.query("DELETE FROM artifacts WHERE id = ?1")
        stale.forEach((item) => remove.run(item.id))
        const unused = db
          .query(
            "SELECT path FROM blobs WHERE NOT EXISTS (SELECT 1 FROM versions WHERE versions.sha256 = blobs.sha256)",
          )
          .all() as Array<{ path: string }>
        db.query(
          "DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM versions WHERE versions.sha256 = blobs.sha256)",
        ).run()
        const referenced = db.query("SELECT path FROM blobs").all() as Array<{ path: string }>
        db.exec("COMMIT")
        return { stale: stale.length, unused, referenced: new Set(referenced.map((item) => item.path)) }
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      } finally {
        db.close()
      }
    })()
    const inspect = !scanned.at || Math.abs(now - scanned.at) >= 60_000
    if (inspect) scanned.at = now
    const physical = inspect ? await physicalBlobs() : []
    const abandoned = physical.filter((item) => !orphaned.referenced.has(item))
    const partial = async function* () {
      if (!inspect) return
      const directory = await fs.opendir(partials).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return
        throw error
      })
      if (!directory) return
      for await (const item of directory) yield path.join(partials, item.name)
    }
    await Cleanup.each(orphaned.unused, (item) => fs.rm(path.join(root, item.path), { force: true }))
    await Cleanup.each(abandoned, (item) => fs.rm(path.join(root, item), { force: true }))
    // Partial entries can be crash-left directories. Process one root at a
    // time so nested cleanup shares a single bounded worker pool.
    await Cleanup.each(partial(), (item) => Cleanup.remove(item), 1)
    return orphaned.stale
  }

  export async function get(projectID: string, artifactID: string): Promise<Detail | undefined> {
    const db = await prepare()
    const row = rows(db, projectID, artifactID)[0]
    if (!row) {
      db.close()
      return
    }
    const versions = (
      db.query("SELECT * FROM versions WHERE artifact_id = ?1 ORDER BY version DESC").all(artifactID) as VersionRow[]
    ).map(version)
    const current = versions.find((item) => item.id === row.current_version_id)
    const run = current?.executionID
      ? (db.query("SELECT * FROM executions WHERE id = ?1").get(current.executionID) as ExecutionRow | null)
      : null
    db.close()
    return {
      ...artifact(row),
      versions,
      ...(run ? { execution: execution(run) } : {}),
    }
  }

  export async function read(
    projectID: string,
    artifactID: string,
    versionID?: string,
  ): Promise<{ info: Version; content: BunFile } | undefined> {
    const db = await prepare()
    const row = db
      .query(
        `SELECT v.*
         FROM versions v
         JOIN artifacts a ON a.id = v.artifact_id
         WHERE a.project_id = ?1 AND a.id = ?2 AND v.id = coalesce(?3, a.current_version_id)`,
      )
      .get(projectID, artifactID, versionID ?? null) as VersionRow | null
    if (!row) {
      db.close()
      return
    }
    const stored = db.query("SELECT path FROM blobs WHERE sha256 = ?1").get(row.sha256) as { path: string } | null
    db.close()
    if (!stored) return
    const filepath = path.join(root, stored.path)
    const stat = await fs.lstat(filepath).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== row.size) return
    const content = Bun.file(filepath)
    if ((await digest(content)) !== row.sha256) return
    return { info: version(row), content }
  }

  export async function reset() {
    using _ = await Lock.write(lock)
    await using lease = await FileLease.acquire(lock)
    await Cleanup.remove(root)
    scanned.at = 0
  }
}
