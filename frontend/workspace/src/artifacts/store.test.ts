import { describe, expect, test } from "bun:test"
import {
  normalizeStoredArtifact,
  normalizeStoredArtifactDetail,
  normalizeStoredArtifacts,
  normalizeStoredArtifactVersion,
  savedResultLabel,
  storedArtifactReviewTargetID,
  type StoredArtifact,
  type StoredArtifactVersion,
} from "./store"

const version: StoredArtifactVersion = {
  id: "ver_test",
  artifactID: "art_test",
  version: 1,
  filename: "result.csv",
  mimeType: "text/csv",
  size: 12,
  sha256: "a".repeat(64),
  sessionID: "ses_test",
  sourcePath: "result.csv",
  captureQuality: "declared",
  createdAt: 2,
}

const artifact: StoredArtifact = {
  schemaVersion: 1,
  id: "art_test",
  projectID: "project_test",
  title: "Result",
  kind: "dataset",
  currentVersionID: "ver_test",
  createdAt: 1,
  updatedAt: 2,
  state: "active",
  versionCount: 1,
  current: version,
}

describe("stored artifact records", () => {
  test("accepts a complete immutable artifact record", () => {
    expect(normalizeStoredArtifactVersion(version)).toEqual(version)
    expect(storedArtifactReviewTargetID(version)).toBe(`artifact-version:ver_test:${"a".repeat(16)}`)
    expect(normalizeStoredArtifact(artifact)).toEqual(artifact)
    expect(normalizeStoredArtifactDetail({ ...artifact, versions: [version] })).toEqual({
      ...artifact,
      versions: [version],
    })
  })

  test("formats a compact save confirmation without exposing the source path", () => {
    const saved = {
      current: {
        ...version,
        filename: "/Users/researcher/private/project/analysis.csv",
        version: 4,
        sourcePath: "/Users/researcher/private/project/analysis.csv",
      },
    }
    expect(savedResultLabel(saved)).toBe("analysis.csv · Version 4")
    expect(savedResultLabel(saved)).not.toContain("/Users/researcher")
  })

  test("drops malformed records instead of inventing artifact metadata", () => {
    expect(normalizeStoredArtifact({ ...artifact, current: { ...version, sha256: undefined } })).toBeUndefined()
    expect(normalizeStoredArtifactDetail({ ...artifact, versions: [] })).toBeUndefined()
    expect(normalizeStoredArtifacts([artifact, null, { title: "fake" }])).toEqual([artifact])
  })

  test("preserves an explicit trash timestamp for recovery UI", () => {
    expect(normalizeStoredArtifact({ ...artifact, state: "trash", trashedAt: 42 })).toMatchObject({
      state: "trash",
      trashedAt: 42,
    })
  })
})
