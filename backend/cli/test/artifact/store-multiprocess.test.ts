import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function environment(root: string) {
  return {
    ...process.env,
    OPENSCIENCE_DATA_DIR: root,
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}

async function result(proc: {
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}) {
  return {
    exit: await proc.exited,
    output: await new Response(proc.stdout).text(),
    error: await new Response(proc.stderr).text(),
  }
}

test("independent processes atomically publish one blob and serialize versions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-artifact-race-"))
  const runner = path.join(root, "save.ts")
  const store = new URL("../../src/artifact/store.ts", import.meta.url).href
  const content = "shared immutable artifact bytes"
  const total = 8
  await Bun.write(
    runner,
    `
import { ArtifactStore } from ${JSON.stringify(store)}
const saved = await ArtifactStore.save({
  projectID: "project-race",
  sessionID: "session-race",
  sourcePath: "results/shared.txt",
  filename: "shared.txt",
  kind: "data",
  content: new Blob([${JSON.stringify(content)}]),
  captureQuality: "exact",
})
console.log(JSON.stringify({ artifactID: saved.id, versionID: saved.currentVersionID }))
`,
  )

  try {
    const processes = Array.from({ length: total }, () =>
      Bun.spawn([process.execPath, runner], {
        env: environment(root),
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(processes.map(result))
    expect(results.filter((result) => result.exit !== 0)).toEqual([])
    const saved = results.map((result) => JSON.parse(result.output.trim()) as Record<string, string>)
    expect(new Set(saved.map((item) => item.artifactID)).size).toBe(1)
    expect(new Set(saved.map((item) => item.versionID)).size).toBe(total)

    const database = path.join(root, "artifact-store", "artifacts.db")
    const db = new Database(database, { readonly: true })
    const versions = db.query("SELECT version, sha256 FROM versions ORDER BY version").all() as Array<{
      version: number
      sha256: string
    }>
    const records = db.query("SELECT sha256, size, path FROM blobs").all() as Array<{
      sha256: string
      size: number
      path: string
    }>
    db.close()
    expect(versions.map((item) => item.version)).toEqual(Array.from({ length: total }, (_, index) => index + 1))
    expect(new Set(versions.map((item) => item.sha256)).size).toBe(1)
    expect(records).toHaveLength(1)
    expect(records[0]?.sha256).toBe(new Bun.CryptoHasher("sha256").update(content).digest("hex"))
    expect(records[0]?.size).toBe(Buffer.byteLength(content))
    const blob = path.join(root, "artifact-store", records[0]!.path)
    expect(await Bun.file(blob).text()).toBe(content)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a last-reference sweep cannot delete a concurrently re-saved blob", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-artifact-sweep-race-"))
  const runner = path.join(root, "race.ts")
  const store = new URL("../../src/artifact/store.ts", import.meta.url).href
  const content = "bytes that must survive sweep"
  await Bun.write(
    runner,
    `
import { ArtifactStore } from ${JSON.stringify(store)}
const input = {
  projectID: "project-race",
  sessionID: "session-race",
  sourcePath: "results/sweep.txt",
  filename: "sweep.txt",
  kind: "data",
  content: new Blob([${JSON.stringify(content)}]),
  captureQuality: "exact",
}
if (process.argv[2] === "seed") {
  const saved = await ArtifactStore.save(input)
  await ArtifactStore.trash(input.projectID, saved.id, 1)
  console.log(JSON.stringify(saved))
}
if (process.argv[2] === "save") console.log(JSON.stringify(await ArtifactStore.save(input)))
if (process.argv[2] === "sweep") console.log(JSON.stringify({ swept: await ArtifactStore.sweep(Date.now()) }))
`,
  )

  try {
    const seed = await result(
      Bun.spawn([process.execPath, runner, "seed"], {
        env: environment(root),
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    expect(seed.exit, seed.error).toBe(0)

    const [saved, swept] = await Promise.all(
      ["save", "sweep"].map((mode) =>
        result(
          Bun.spawn([process.execPath, runner, mode], {
            env: environment(root),
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
      ),
    )
    expect([saved, swept].filter((item) => item?.exit !== 0)).toEqual([])

    const database = path.join(root, "artifact-store", "artifacts.db")
    const db = new Database(database, { readonly: true })
    const record = db
      .query(
        `SELECT a.id, a.state, v.sha256, b.path
         FROM artifacts a
         JOIN versions v ON v.id = a.current_version_id
         JOIN blobs b ON b.sha256 = v.sha256
         WHERE a.project_id = 'project-race' AND a.source_key = 'results/sweep.txt'`,
      )
      .get() as { id: string; state: string; sha256: string; path: string } | null
    db.close()
    expect(record?.state).toBe("active")
    expect(record?.sha256).toBe(new Bun.CryptoHasher("sha256").update(content).digest("hex"))
    expect(await Bun.file(path.join(root, "artifact-store", record!.path)).text()).toBe(content)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
