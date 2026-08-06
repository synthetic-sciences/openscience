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
    expect(repeated.conflict).toBeUndefined()
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
    expect(result.conflict).toBeUndefined()
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
})
