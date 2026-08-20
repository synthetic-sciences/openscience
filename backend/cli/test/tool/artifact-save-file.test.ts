import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { ProvenanceEnvelope } from "../../src/science/provenance/envelope"
import { Provenance } from "../../src/science/provenance/store"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SessionReview } from "../../src/session/review"
import { ArtifactTool } from "../../src/tool/artifact"
import { executionSession, tmpdir } from "../fixture/fixture"

const context = (sessionID: string) => ({
  sessionID,
  messageID: "msg_artifact_save_file",
  callID: "call_artifact_save_file",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
})

test("artifact save_file promotes a workspace result into immutable versions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ArtifactTool.init()
      const autoReview = spyOn(SessionReview, "auto").mockResolvedValue(undefined)
      const workspace = await SessionFilesystem.workspace(session.id)
      const target = path.join(workspace, "results", "titanic-report.md")
      await Bun.write(target, "# Titanic analysis\n\nFirst verified result.\n")

      const first = await tool.execute(
        { action: "save_file", path: "results/titanic-report.md", summary: "Titanic analysis report" },
        context(session.id),
      )
      await Bun.write(target, "# Titanic analysis\n\nImproved verified result.\n")
      const second = await tool.execute(
        { action: "save_file", path: "results/titanic-report.md", summary: "Titanic analysis report" },
        context(session.id),
      )
      const firstSaved = first.metadata.savedArtifact as { id: string }

      expect(autoReview).toHaveBeenCalledTimes(2)
      expect(autoReview).toHaveBeenCalledWith(session.id, "research")
      autoReview.mockRestore()

      expect(first.title).toBe("Saved Result: Titanic analysis report")
      expect(first.metadata.savedArtifact).toMatchObject({
        version: 1,
        title: "Titanic analysis report",
        kind: "report",
        path: "results/titanic-report.md",
        mimeType: "text/markdown",
        preview: { kind: "text", data: "# Titanic analysis\n\nFirst verified result.\n" },
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(second.metadata.savedArtifact).toMatchObject({
        id: firstSaved.id,
        version: 2,
      })
      expect(await ArtifactStore.list(Instance.project.id)).toHaveLength(1)
      const detail = await ArtifactStore.get(Instance.project.id, firstSaved.id)
      expect(detail).toMatchObject({ versionCount: 2 })
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      for (const version of detail!.versions) {
        expect(await Provenance.find(scope, ArtifactStore.reviewTargetID(version.id, version.sha256))).toMatchObject({
          kind: "artifact",
          meta: { artifactID: firstSaved.id, versionID: version.id, sessionID: session.id },
        })
      }
    },
  })
})

test("artifact save_file never persists a blank display title", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ArtifactTool.init()
      const workspace = await SessionFilesystem.workspace(session.id)
      await Bun.write(path.join(workspace, "result.csv"), "metric,value\naccuracy,0.91\n")

      const saved = await tool.execute({ action: "save_file", path: "result.csv", summary: "   " }, context(session.id))

      expect(saved.title).toBe("Saved Result: result.csv")
      expect(saved.metadata.savedArtifact).toMatchObject({
        title: "result.csv",
        kind: "dataset",
        mimeType: "text/csv",
        preview: { kind: "text", data: "metric,value\naccuracy,0.91\n" },
      })
    },
  })
})

test("artifact save_file binds the immutable result to its exact producing execution", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ArtifactTool.init()
      const workspace = await SessionFilesystem.workspace(session.id)
      await Bun.write(path.join(workspace, "result.csv"), "metric,value\naccuracy,0.91\n")
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      const run = await Provenance.recordOwned(scope, {
        id: "run_artifact_save_file",
        kind: "run",
        label: "Python execution",
        tool: "python",
        sessionID: session.id,
        status: "ok",
        inputs: { code: "write_result()" },
        provenance: ProvenanceEnvelope.create({
          kind: "kernel",
          projectID: Instance.project.id,
          sessionID: session.id,
          runID: "run_artifact_save_file",
          code: "write_result()",
          status: "succeeded",
          outputs: [],
          createdAt: Date.now(),
          startedAt: Date.now(),
          completedAt: Date.now(),
        }),
        meta: { stdout: "saved result.csv", stderr: "", effort: "normal" },
      } as Parameters<typeof Provenance.record>[0])

      const response = await tool.execute(
        { action: "save_file", path: "result.csv", provenance_id: run.id },
        context(session.id),
      )
      const saved = response.metadata.savedArtifact as { id: string; versionID: string }
      const detail = await ArtifactStore.get(Instance.project.id, saved.id)
      expect(detail?.execution).toMatchObject({
        command: "python",
        code: "write_result()",
        status: "succeeded",
        stdout: "saved result.csv",
        effort: "normal",
        source: run.id,
        captureQuality: "exact",
      })
      const graph = await Provenance.project(scope)
      const target = ArtifactStore.reviewTargetID(saved.versionID, detail!.current.sha256)
      expect(graph.edges).toContainEqual({ from: run.id, to: target, relation: "produced" })
    },
  })
})

test("artifact save_file accepts a project-owned manually recorded run from the same session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ArtifactTool.init()
      const workspace = await SessionFilesystem.workspace(session.id)
      await Bun.write(path.join(workspace, "review.pdf"), "%PDF-1.5\nmanual result\n")
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      const run = await Provenance.recordOwned(scope, {
        kind: "run",
        label: "Compile review",
        tool: "tectonic, pdfinfo",
        meta: {
          sessionID: session.id,
          projectID: Instance.project.id,
          stdout: "review.pdf validated",
        },
      } as Parameters<typeof Provenance.record>[0])

      const response = await tool.execute(
        { action: "save_file", path: "review.pdf", provenance_id: run.id },
        context(session.id),
      )
      const saved = response.metadata.savedArtifact as { id: string; versionID: string }
      const detail = await ArtifactStore.get(Instance.project.id, saved.id)
      expect(detail?.execution).toMatchObject({
        command: "tectonic, pdfinfo",
        status: "unknown",
        stdout: "review.pdf validated",
        source: run.id,
        captureQuality: "declared",
      })
      expect((await Provenance.project(scope)).edges).toContainEqual({
        from: run.id,
        to: ArtifactStore.reviewTargetID(saved.versionID, detail!.current.sha256),
        relation: "produced",
      })
    },
  })
})
