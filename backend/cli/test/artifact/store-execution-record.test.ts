import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Global } from "../../src/global"

// get() builds artifacts, versions and the execution together, so one bad
// executions.files value took down the whole artifact detail. A partially
// written or externally edited row must degrade to "no files recorded" instead.
const database = path.join(Global.Path.data, "artifact-store", "artifacts.db")

async function save(projectID: string) {
  return await ArtifactStore.save({
    projectID,
    sessionID: `session-${projectID}`,
    sourcePath: "results/out.txt",
    filename: "out.txt",
    kind: "data",
    content: new Blob(["artifact bytes"]),
    captureQuality: "exact",
    execution: {
      status: "succeeded",
      captureQuality: "exact",
      files: [{ path: "results/out.txt", sha256: "a".repeat(64), size: 14 }],
    },
  })
}

test("a corrupt execution record still returns the artifact detail", async () => {
  const projectID = "project-corrupt-execution"
  const saved = await save(projectID)

  const db = new Database(database)
  db.run("UPDATE executions SET files = '[{\"path\":' WHERE artifact_version_id = ?1", [saved.currentVersionID])
  db.close()

  const detail = await ArtifactStore.get(projectID, saved.id)

  expect(detail).toBeDefined()
  expect(detail!.title).toBe("out.txt")
  expect(detail!.versions).toHaveLength(1)
  expect(detail!.execution?.files).toEqual([])
})

test("an execution record that is not a file list still returns the artifact detail", async () => {
  const projectID = "project-nonarray-execution"
  const saved = await save(projectID)

  const db = new Database(database)
  db.run("UPDATE executions SET files = 'null' WHERE artifact_version_id = ?1", [saved.currentVersionID])
  db.close()

  const detail = await ArtifactStore.get(projectID, saved.id)

  expect(detail).toBeDefined()
  expect(detail!.execution?.files).toEqual([])
})

test("a well-formed execution record still reports its files", async () => {
  const projectID = "project-intact-execution"
  const saved = await save(projectID)

  const detail = await ArtifactStore.get(projectID, saved.id)

  expect(detail!.execution?.files).toEqual([{ path: "results/out.txt", sha256: "a".repeat(64), size: 14 }])
})
