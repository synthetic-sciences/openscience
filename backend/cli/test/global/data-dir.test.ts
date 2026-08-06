import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveDataDirectory } from "@/global/data-dir"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-data-dir-"))
  roots.push(value)
  return value
}

async function artifact(root: string, key: string) {
  const dir = path.join(root, "artifact-store")
  await fs.mkdir(path.join(dir, "blobs"), { recursive: true })
  await fs.writeFile(path.join(dir, "blobs", key), key)
  const db = new Database(path.join(dir, "artifacts.db"), { create: true })
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE blobs (
      sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, project_id TEXT NOT NULL, source_key TEXT NOT NULL,
      title TEXT NOT NULL, kind TEXT NOT NULL, current_version_id TEXT NOT NULL, state TEXT NOT NULL,
      trashed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(project_id, source_key)
    );
    CREATE TABLE versions (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), version INTEGER NOT NULL,
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
      sha256 TEXT NOT NULL REFERENCES blobs(sha256), session_id TEXT NOT NULL, message_id TEXT,
      execution_id TEXT, source_path TEXT NOT NULL, capture_quality TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(artifact_id, version)
    );
    CREATE TABLE executions (
      id TEXT PRIMARY KEY, artifact_version_id TEXT NOT NULL UNIQUE REFERENCES versions(id), command TEXT, code TEXT,
      status TEXT NOT NULL, stdout TEXT, stderr TEXT, model TEXT, provider TEXT, effort TEXT, source TEXT,
      permission_snapshot TEXT, inputs TEXT, capture_quality TEXT NOT NULL, files TEXT NOT NULL,
      environment TEXT, created_at INTEGER NOT NULL
    );
  `)
  db.query("INSERT INTO blobs VALUES (?1, ?2, ?3, ?4)").run(key, key.length, `blobs/${key}`, 1)
  db.query("INSERT INTO artifacts VALUES (?1, 1, ?2, ?3, ?4, 'document', ?5, 'active', NULL, 1, 1)").run(
    `art_${key}`,
    `prj_${key}`,
    `/tmp/${key}.txt`,
    key,
    `ver_${key}`,
  )
  db.query("INSERT INTO versions VALUES (?1, ?2, 1, ?3, 'text/plain', ?4, ?5, ?6, NULL, ?7, ?8, 'exact', 1)").run(
    `ver_${key}`,
    `art_${key}`,
    `${key}.txt`,
    key.length,
    key,
    `ses_${key}`,
    `exe_${key}`,
    `/tmp/${key}.txt`,
  )
  db.query(
    "INSERT INTO executions VALUES (?1, ?2, NULL, NULL, 'succeeded', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'exact', '[]', NULL, 1)",
  ).run(`exe_${key}`, `ver_${key}`)
  db.close()
}

describe("OpenScience data directory", () => {
  test("prefers explicit and pointer locations without migrating", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")

    expect((await resolveDataDirectory({ home, legacy, explicit: "./custom" })).path).toBe(path.resolve("./custom"))
    expect((await resolveDataDirectory({ home, legacy, pointer: "./pointed" })).path).toBe(path.resolve("./pointed"))
  })

  test("copies, checksums, and retains legacy data before selecting ~/.openscience", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    await fs.mkdir(path.join(legacy, "storage"), { recursive: true })
    await fs.writeFile(path.join(legacy, "storage", "session.json"), '{"title":"kept"}\n')
    await fs.mkdir(path.join(home, ".openscience", "bin"), { recursive: true })
    await fs.writeFile(path.join(home, ".openscience", "bin", "openscience"), "launcher")

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.path).toBe(path.join(home, ".openscience"))
    expect(result.migrated?.files).toBe(1)
    expect(await fs.readFile(path.join(result.path, "storage", "session.json"), "utf8")).toContain("kept")
    expect(await fs.readFile(path.join(legacy, "storage", "session.json"), "utf8")).toContain("kept")
    expect(await fs.readFile(path.join(result.path, "bin", "openscience"), "utf8")).toBe("launcher")
    expect(JSON.parse(await fs.readFile(path.join(result.path, ".xdg-data-migration-v2.json"), "utf8")).source).toBe(
      legacy,
    )

    const repeated = await resolveDataDirectory({ home, legacy })
    expect(repeated.path).toBe(result.path)
    expect(repeated.migrated).toBeUndefined()
  })

  test("merges missing projects, sessions, and credentials into a populated root", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(path.join(legacy, "storage", "project"), { recursive: true })
    await fs.mkdir(path.join(legacy, "storage", "session", "prj_old"), { recursive: true })
    await fs.mkdir(path.join(target, "storage", "project"), { recursive: true })
    await fs.writeFile(path.join(target, ".xdg-data-migration-v1.json"), "{}")
    await fs.writeFile(path.join(legacy, "storage", "project", "prj_old.json"), '{"name":"old"}')
    await fs.writeFile(path.join(legacy, "storage", "session", "prj_old", "ses_old.json"), '{"title":"old"}')
    await fs.writeFile(path.join(target, "storage", "project", "prj_new.json"), '{"name":"new"}')
    await fs.writeFile(path.join(legacy, "shared.json"), "legacy")
    await fs.writeFile(path.join(target, "shared.json"), "current")
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"access_token":"restored"}')
    await fs.writeFile(
      path.join(legacy, "auth.json"),
      JSON.stringify({ "openai-codex": { access: "old" }, anthropic: { key: "kept" } }),
    )
    await fs.writeFile(
      path.join(target, "auth.json"),
      JSON.stringify({ "openai-codex": { access: "current" }, openrouter: { key: "current" } }),
    )

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.path).toBe(target)
    expect(result.error).toBeUndefined()
    expect(result.migrated?.merged).toBe(1)
    expect(await fs.readFile(path.join(target, "storage", "project", "prj_old.json"), "utf8")).toContain("old")
    expect(await fs.readFile(path.join(target, "storage", "project", "prj_new.json"), "utf8")).toContain("new")
    expect(await fs.readFile(path.join(target, "storage", "session", "prj_old", "ses_old.json"), "utf8")).toContain(
      "old",
    )
    expect(await fs.readFile(path.join(target, "shared.json"), "utf8")).toBe("current")
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("restored")
    expect(JSON.parse(await fs.readFile(path.join(target, "auth.json"), "utf8"))).toEqual({
      "openai-codex": { access: "current" },
      anthropic: { key: "kept" },
      openrouter: { key: "current" },
    })
    expect(await fs.readFile(path.join(legacy, "storage", "project", "prj_old.json"), "utf8")).toContain("old")

    const repeated = await resolveDataDirectory({ home, legacy })
    expect(repeated.migrated).toBeUndefined()
  })

  test("merges legacy artifact records and blobs into an existing artifact store", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await artifact(legacy, "legacy")
    await artifact(target, "current")

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.error).toBeUndefined()
    expect(result.migrated?.artifacts).toBe(1)
    expect(await fs.readFile(path.join(target, "artifact-store", "blobs", "legacy"), "utf8")).toBe("legacy")
    const current = new Database(path.join(target, "artifact-store", "artifacts.db"), { readonly: true })
    expect(
      (current.query("SELECT id FROM artifacts ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(["art_current", "art_legacy"])
    expect((current.query("SELECT count(*) AS value FROM versions").get() as { value: number }).value).toBe(2)
    expect((current.query("SELECT count(*) AS value FROM executions").get() as { value: number }).value).toBe(2)
    current.close()

    const source = new Database(path.join(legacy, "artifact-store", "artifacts.db"), { readonly: true })
    expect((source.query("SELECT count(*) AS value FROM artifacts").get() as { value: number }).value).toBe(1)
    source.close()
  })

  test("leaves logs and per-process sidecars behind", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await artifact(legacy, "legacy")
    await fs.mkdir(path.join(legacy, "log"), { recursive: true })
    await fs.writeFile(path.join(legacy, "log", "2026-08-06.log"), "noise")
    await fs.writeFile(path.join(legacy, "artifact-store", "artifacts.db-wal"), "journal")
    await fs.writeFile(path.join(legacy, "artifact-store", "artifacts.db-shm"), "shared")
    await fs.writeFile(path.join(legacy, "auth.json.lock"), "{}")
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.error).toBeUndefined()
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("kept")
    expect(fsSync.existsSync(path.join(target, "artifact-store", "artifacts.db"))).toBe(true)
    for (const orphan of [
      "log",
      "artifact-store/artifacts.db-wal",
      "artifact-store/artifacts.db-shm",
      "auth.json.lock",
    ])
      expect(fsSync.existsSync(path.join(target, orphan))).toBe(false)
  })

  test("imports credentials and history even when the legacy artifact store is corrupt", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await artifact(target, "current")
    await fs.mkdir(path.join(legacy, "artifact-store"), { recursive: true })
    await fs.writeFile(path.join(legacy, "artifact-store", "artifacts.db"), "not a database")
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')
    await fs.writeFile(path.join(legacy, "auth.json"), JSON.stringify({ "openai-codex": { access: "kept" } }))

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.path).toBe(target)
    expect(result.error).toBeUndefined()
    expect(result.warning).toContain("artifact store")
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("kept")
    expect(JSON.parse(await fs.readFile(path.join(target, "auth.json"), "utf8"))["openai-codex"].access).toBe("kept")
    expect(fsSync.existsSync(path.join(target, ".xdg-data-migration-v2.json"))).toBe(true)
  })

  test("imports every other file when one changes under the copy", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(path.join(legacy, "storage", "session"), { recursive: true })
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')
    await fs.writeFile(path.join(legacy, "auth.json"), JSON.stringify({ "openai-codex": { access: "kept" } }))
    for (const id of ["a", "b", "c"])
      await fs.writeFile(path.join(legacy, "storage", "session", `ses_${id}.json`), `{"id":"${id}"}`)

    // A still-running instance rewrites one session between the copy and its
    // verification. Only that file may be dropped.
    const torn = path.join(legacy, "storage", "session", "ses_b.json")
    const original = fsSync.readFileSync(torn)
    const watcher = setInterval(() => fsSync.writeFileSync(torn, `{"id":"b","n":${Math.random()}}`), 1)
    const result = await resolveDataDirectory({ home, legacy }).finally(() => clearInterval(watcher))

    expect(result.path).toBe(target)
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("kept")
    expect(JSON.parse(await fs.readFile(path.join(target, "auth.json"), "utf8"))["openai-codex"].access).toBe("kept")
    for (const id of ["a", "c"])
      expect(fsSync.existsSync(path.join(target, "storage", "session", `ses_${id}.json`))).toBe(true)
    fsSync.writeFileSync(torn, original)
  })

  test("keeps concurrent boots on a single data root", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(path.join(legacy, "storage", "session"), { recursive: true })
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')
    await fs.writeFile(path.join(legacy, "auth.json"), JSON.stringify({ "openai-codex": { access: "kept" } }))
    for (const id of ["a", "b", "c"])
      await fs.writeFile(path.join(legacy, "storage", "session", `ses_${id}.json`), `{"id":"${id}"}`)

    const results = await Promise.all([
      resolveDataDirectory({ home, legacy }),
      resolveDataDirectory({ home, legacy }),
      resolveDataDirectory({ home, legacy }),
    ])

    expect(results.map((result) => result.path)).toEqual([target, target, target])
    expect(JSON.parse(await fs.readFile(path.join(target, "auth.json"), "utf8"))["openai-codex"].access).toBe("kept")
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("kept")
    for (const id of ["a", "b", "c"])
      expect(fsSync.existsSync(path.join(target, "storage", "session", `ses_${id}.json`))).toBe(true)
  })

  test("survives a file vanishing between the walk and the copy", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    await fs.mkdir(path.join(legacy, "storage", "session"), { recursive: true })
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')
    for (let i = 0; i < 400; i++)
      await fs.writeFile(path.join(legacy, "storage", "session", `ses_${i}.json`), `{"i":${i}}`)

    // A still-running instance deleting sessions throughout the import. This
    // walk sits behind a top-level await in global/index.ts, so an escaping
    // ENOENT would stop the CLI from booting at all.
    const doomed = Array.from({ length: 400 }, (_, i) => path.join(legacy, "storage", "session", `ses_${i}.json`))
    const killer = setInterval(() => {
      const victim = doomed.pop()
      if (victim) fsSync.rmSync(victim, { force: true })
    }, 0)
    const result = await resolveDataDirectory({ home, legacy }).finally(() => clearInterval(killer))

    expect(result.path).toBe(path.join(home, ".openscience"))
    expect(result.error).toBeUndefined()
    expect(await fs.readFile(path.join(result.path, "openscience-session.json"), "utf8")).toContain("kept")
  })

  test("an unreadable file costs that file and nothing else", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(path.join(legacy, "storage", "session"), { recursive: true })
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')
    await fs.writeFile(path.join(legacy, "auth.json"), JSON.stringify({ "openai-codex": { access: "kept" } }))
    await fs.writeFile(path.join(legacy, "storage", "session", "locked.json"), "{}")
    await fs.chmod(path.join(legacy, "storage", "session", "locked.json"), 0o000)

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.error).toBeUndefined()
    expect(result.migrated?.deferred).toBe(1)
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("kept")
    expect(JSON.parse(await fs.readFile(path.join(target, "auth.json"), "utf8"))["openai-codex"].access).toBe("kept")
    // Sealed, but the straggler is named, so the retry costs one stat rather
    // than a fresh walk of the whole legacy tree on every later launch.
    const record = path.join(target, ".xdg-data-migration-v2.json")
    expect(JSON.parse(await fs.readFile(record, "utf8")).pending).toEqual(["storage/session/locked.json"])

    await fs.chmod(path.join(legacy, "storage", "session", "locked.json"), 0o600)
    const retry = await resolveDataDirectory({ home, legacy })
    expect(retry.migrated?.deferred).toBe(0)
    expect(fsSync.existsSync(path.join(target, "storage", "session", "locked.json"))).toBe(true)
    // Resuming keeps the original import's record and clears the list, so the
    // launch after this one takes the one-stat path.
    const after = JSON.parse(await fs.readFile(record, "utf8"))
    expect(after.pending).toEqual([])
    expect(after.migratedAt).toBeDefined()

    const settled = await resolveDataDirectory({ home, legacy })
    expect(settled.migrated).toBeUndefined()
    expect(settled.path).toBe(target)
  })

  test("a straggler that disappears stops being chased", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')
    await fs.writeFile(path.join(legacy, "gone.json"), "{}")
    await fs.chmod(path.join(legacy, "gone.json"), 0o000)

    expect((await resolveDataDirectory({ home, legacy })).migrated?.deferred).toBe(1)
    await fs.rm(path.join(legacy, "gone.json"), { force: true })

    const retry = await resolveDataDirectory({ home, legacy })

    expect(retry.path).toBe(target)
    const record = JSON.parse(await fs.readFile(path.join(target, ".xdg-data-migration-v2.json"), "utf8"))
    expect(record.pending).toEqual([])
  })

  test("never writes outside the target for a hand-edited pending list", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(legacy, { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(home, "secret"), "original")
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"legacy"}')
    await fs.writeFile(
      path.join(target, ".xdg-data-migration-v2.json"),
      JSON.stringify({ pending: ["../secret", "/etc/passwd", "openscience-session.json"] }),
    )

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.path).toBe(target)
    expect(await fs.readFile(path.join(home, "secret"), "utf8")).toBe("original")
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("legacy")
  })

  test("a corrupt legacy credential store does not abort the import", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "openscience-session.json"), '{"api_key":"kept"}')
    await fs.writeFile(path.join(legacy, "auth.json"), '{"openai-codex":{"acce')

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.path).toBe(target)
    expect(result.error).toBeUndefined()
    expect(result.warning).toContain("auth.json")
    expect(await fs.readFile(path.join(target, "openscience-session.json"), "utf8")).toContain("kept")
    // Sealed: a corrupt source is not going to parse on the next boot either,
    // so re-running the whole import forever helps nobody.
    expect(fsSync.existsSync(path.join(target, ".xdg-data-migration-v2.json"))).toBe(true)
  })

  test("does not import credentials sealed with a different machine key", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(legacy, { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(legacy, "credentials.key"), Buffer.alloc(32, 1))
    await fs.writeFile(path.join(target, "credentials.key"), Buffer.alloc(32, 2))
    await fs.writeFile(
      path.join(legacy, "credentials.json"),
      JSON.stringify({ github: { fields: { GITHUB_TOKEN: "ciphertext" }, updated_at: "1" } }),
    )
    await fs.writeFile(path.join(legacy, "auth.json"), JSON.stringify({ "openai-codex": { access: "kept" } }))

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.warning).toContain("different machine key")
    // Undecryptable entries would show as "set" in the UI and inject nothing.
    expect(fsSync.existsSync(path.join(target, "credentials.json"))).toBe(false)
    expect(await fs.readFile(path.join(target, "credentials.key"))).toEqual(Buffer.alloc(32, 2))
    expect(JSON.parse(await fs.readFile(path.join(target, "auth.json"), "utf8"))["openai-codex"].access).toBe("kept")
  })

  test("carries a SQLite journal only alongside its own database", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    // `settings/memory/index.db` is the second WAL database (memory-index.ts)
    // and nothing merges it, so what the copy decides is what survives.
    await fs.mkdir(path.join(legacy, "settings", "memory"), { recursive: true })
    await fs.mkdir(path.join(legacy, "settings", "notes"), { recursive: true })
    await fs.mkdir(path.join(target, "settings", "memory"), { recursive: true })
    await fs.writeFile(path.join(legacy, "settings", "memory", "index.db"), "legacy-index")
    await fs.writeFile(path.join(legacy, "settings", "memory", "index.db-wal"), "memory-journal")
    await fs.writeFile(path.join(target, "settings", "memory", "index.db"), "current-index")
    await fs.writeFile(path.join(legacy, "settings", "notes", "index.db"), "legacy-notes")
    await fs.writeFile(path.join(legacy, "settings", "notes", "index.db-wal"), "notes-journal")

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.error).toBeUndefined()
    // notes/index.db is carried, so its journal travels with it — dropping it
    // would lose every transaction still in the log.
    expect(await fs.readFile(path.join(target, "settings", "notes", "index.db"), "utf8")).toBe("legacy-notes")
    expect(await fs.readFile(path.join(target, "settings", "notes", "index.db-wal"), "utf8")).toBe("notes-journal")
    // memory/index.db is not — the target has its own — so the legacy journal
    // must not land beside a database it never described.
    expect(await fs.readFile(path.join(target, "settings", "memory", "index.db"), "utf8")).toBe("current-index")
    expect(fsSync.existsSync(path.join(target, "settings", "memory", "index.db-wal"))).toBe(false)
  })
})
