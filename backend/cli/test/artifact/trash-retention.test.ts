import { expect, test } from "bun:test"
import { ArtifactStore } from "../../src/artifact/store"

test("re-trashing a trashed artifact keeps its original retention clock", async () => {
  const projectID = "project-retrash-retention"
  const saved = await ArtifactStore.save({
    projectID,
    sessionID: "session-retrash-retention",
    sourcePath: "results/retrash.txt",
    filename: "retrash.txt",
    kind: "data",
    content: new Blob(["retention bytes"]),
    captureQuality: "exact",
  })

  const trashedAt = Date.now() - ArtifactStore.TRASH_RETENTION_MS - 60_000
  expect((await ArtifactStore.trash(projectID, saved.id, trashedAt))?.trashedAt).toBe(trashedAt)

  // A second trash call must not move the deletion deadline into the future.
  expect((await ArtifactStore.trash(projectID, saved.id, Date.now() - 1_000))?.trashedAt).toBe(trashedAt)

  expect(await ArtifactStore.sweep(Date.now())).toBeGreaterThanOrEqual(1)
  expect(await ArtifactStore.get(projectID, saved.id)).toBeUndefined()
})
