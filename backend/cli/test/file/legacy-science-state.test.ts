import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { expect, test } from "bun:test"
import { ArtifactAnnotation } from "../../src/file/annotations"
import { PublicationReview } from "../../src/file/review"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

test("adopts legacy annotation and publication-review history into the opaque project", async () => {
  await using tmp = await tmpdir({
    init: async (directory) => {
      await Bun.write(path.join(directory, "results.csv"), "metric,value\naccuracy,0.9\n")
      await Bun.write(path.join(directory, "report.md"), "# Result\n")
    },
  })
  const legacy = createHash("sha256").update(tmp.path).digest("hex").slice(0, 40)
  const annotationID = `ann_${randomUUID()}`
  const reviewID = `review_${randomUUID()}`
  const annotation = {
    id: annotationID,
    projectID: legacy,
    path: "results.csv",
    artifactHash: "a".repeat(64),
    anchor: { kind: "artifact" as const, label: "results.csv" },
    messages: [{ id: "msg_legacy", body: "Keep this audit note.", author: "Reviewer", createdAt: 1 }],
    status: "resolved" as const,
    version: 2,
    revisions: [
      {
        version: 1,
        event: "created" as const,
        actor: "Reviewer",
        at: 1,
        status: "open" as const,
        messages: [{ id: "msg_legacy", body: "Keep this audit note.", author: "Reviewer", createdAt: 1 }],
      },
      {
        version: 2,
        event: "resolved" as const,
        actor: "Reviewer",
        at: 2,
        status: "resolved" as const,
        messages: [{ id: "msg_legacy", body: "Keep this audit note.", author: "Reviewer", createdAt: 1 }],
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  }
  const review = {
    format: "openscience.publication-review.v1" as const,
    id: reviewID,
    projectID: legacy,
    path: "report.md",
    artifactHash: "b".repeat(64),
    version: 2,
    status: "warnings" as const,
    summary: {
      total: 1,
      open: 0,
      blocking: 0,
      major: 0,
      minor: 1,
      info: 0,
      resolved: 1,
      overridden: 0,
    },
    findings: [
      {
        id: "finding_legacy",
        check: "numeric" as const,
        severity: "minor" as const,
        status: "resolved" as const,
        title: "Legacy numeric check",
        detail: "The number was independently verified.",
        evidence: ["results.csv:2"],
        location: { path: "report.md", line: 1 },
        resolution: {
          kind: "resolved" as const,
          actor: "Reviewer",
          reason: "Verified against the durable result.",
          at: 2,
        },
      },
    ],
    events: [
      { version: 1, type: "generated" as const, actor: "OpenScience", at: 1 },
      {
        version: 2,
        type: "resolved" as const,
        actor: "Reviewer",
        at: 2,
        findingID: "finding_legacy",
        reason: "Verified against the durable result.",
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  }
  await Storage.write(["project", legacy], {
    id: legacy,
    worktree: tmp.path,
    sandboxes: [],
    time: { created: 1, updated: 1 },
  })
  await Storage.write(["artifact_annotation", legacy, annotationID], annotation)
  await Storage.write(["publication_review", legacy, reviewID], review)

  const result = await Instance.provide({
    directory: tmp.path,
    fn: async () => ({
      projectID: Instance.project.id,
      annotation: await ArtifactAnnotation.history(annotationID),
      review: await PublicationReview.get(reviewID),
    }),
  })

  expect(result.projectID).toStartWith("prj_")
  expect(result.annotation).toEqual({
    ...annotation,
    projectID: result.projectID,
  })
  expect(result.review).toEqual({
    ...review,
    projectID: result.projectID,
    dependencies: [],
  })
  expect(await Storage.read(["artifact_annotation", legacy, annotationID]).catch(() => undefined)).toBeUndefined()
  expect(await Storage.read(["publication_review", legacy, reviewID]).catch(() => undefined)).toBeUndefined()
  expect(await Storage.read<ArtifactAnnotation.Info>(["artifact_annotation", result.projectID, annotationID])).toEqual(
    result.annotation,
  )
  expect(await Storage.read<PublicationReview.Report>(["publication_review", result.projectID, reviewID])).toEqual(
    result.review,
  )
})

test("does not overwrite or delete divergent canonical science records", async () => {
  await using tmp = await tmpdir({
    init: async (directory) => {
      await Bun.write(path.join(directory, "results.csv"), "metric,value\naccuracy,0.9\n")
    },
  })
  const legacy = createHash("sha256").update(tmp.path).digest("hex").slice(0, 40)
  await Storage.write(["project", legacy], {
    id: legacy,
    worktree: tmp.path,
    sandboxes: [],
    time: { created: 1, updated: 1 },
  })
  const project = (await Project.fromDirectory(tmp.path)).project
  const id = `ann_${randomUUID()}`
  const record = (projectID: string, body: string, version: number) => ({
    id,
    projectID,
    path: "results.csv",
    artifactHash: "c".repeat(64),
    anchor: { kind: "artifact" as const },
    messages: [{ id: `msg_${version}`, body, author: "Reviewer", createdAt: version }],
    status: "open" as const,
    version,
    revisions: [
      {
        version,
        event: "created" as const,
        actor: "Reviewer",
        at: version,
        status: "open" as const,
        messages: [{ id: `msg_${version}`, body, author: "Reviewer", createdAt: version }],
      },
    ],
    createdAt: version,
    updatedAt: version,
  })
  const canonical = record(project.id, "Canonical review thread", 2)
  const stranded = record(legacy, "Divergent legacy review thread", 7)
  await Storage.write(["artifact_annotation", project.id, id], canonical)
  await Storage.write(["artifact_annotation", legacy, id], stranded)

  const selected = await Instance.provide({
    directory: tmp.path,
    fn: () => ArtifactAnnotation.history(id),
  })

  expect(selected).toEqual(canonical)
  expect(await Storage.read<ReturnType<typeof record>>(["artifact_annotation", project.id, id])).toEqual(canonical)
  expect(await Storage.read<ReturnType<typeof record>>(["artifact_annotation", legacy, id])).toEqual(stranded)
})
