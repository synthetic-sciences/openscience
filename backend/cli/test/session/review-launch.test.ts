import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import { ArtifactStore } from "../../src/artifact/store"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Provenance } from "../../src/science/provenance/store"
import { SessionRoutes } from "../../src/server/routes/session"
import { Session } from "../../src/session"
import { SessionReview } from "../../src/session/review"
import { SessionPrompt } from "../../src/session/prompt"
import { ReviewSettings } from "../../src/settings/review"
import { ArtifactSnapshotTool } from "../../src/tool/artifact-snapshot"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await ArtifactStore.reset()
  await ReviewSettings.set({ auto: false, model: null })
})

test("review settings choose the model and auto-review only opted-in Result saves", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "configured review" })
      const selected = { providerID: "test-provider", modelID: "test-review-model" }
      const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as never)
      try {
        await ReviewSettings.set({ auto: false, model: selected })
        await SessionReview.auto(session.id, "research")
        expect(prompt).not.toHaveBeenCalled()

        await SessionReview.start(session.id)
        expect(prompt).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionID: session.id, agent: "reviewer", model: selected }),
        )

        prompt.mockClear()
        await ReviewSettings.set({ auto: true, model: selected })
        await SessionReview.auto(session.id, "research")
        expect(prompt).toHaveBeenCalledWith(
          expect.objectContaining({ sessionID: session.id, agent: "reviewer", model: selected }),
        )

        prompt.mockClear()
        await SessionReview.auto(session.id, "reviewer")
        await SessionReview.auto(session.id, "artifact-reviewer")
        expect(prompt).not.toHaveBeenCalled()
      } finally {
        prompt.mockRestore()
        await Session.remove(session.id)
      }
    },
  })
})

test("a direct review grants the reviewer's provenance tools at session scope", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "review target" })
      expect(session.permission ?? []).toHaveLength(0)

      const launched = await SessionRoutes().request(`/${session.id}/review`, { method: "POST" })
      expect(launched.status).toBe(200)
      expect(await launched.json()).toEqual({ started: true })

      const updated = await Session.get(session.id)
      const rules = updated.permission ?? []
      expect(rules).toContainEqual({ permission: "provenance_query", pattern: "*", action: "allow" })
      expect(rules).toContainEqual({ permission: "provenance_review", pattern: "*", action: "allow" })

      // Idempotent: a second launch does not duplicate the grants.
      await SessionReview.start(session.id)
      const again = await Session.get(session.id)
      expect((again.permission ?? []).filter((rule) => rule.permission === "provenance_query")).toHaveLength(1)

      await Session.remove(session.id)
    },
  })
})

test("an artifact review is bound to one immutable version and cannot access the live workspace", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "artifact review target" })
      const source = path.join(tmp.path, "result.md")
      await Bun.write(source, "# Result\n\nMeasured value: 42.\n")
      const first = await ArtifactStore.save({
        projectID: Instance.project.id,
        sessionID: session.id,
        sourcePath: "result.md",
        filename: "result.md",
        kind: "report",
        content: Bun.file(source),
        mimeType: "text/markdown",
      })
      await Bun.write(source, "# Result\n\nMeasured value: 99.\n")
      const second = await ArtifactStore.save({
        projectID: Instance.project.id,
        sessionID: session.id,
        sourcePath: "result.md",
        filename: "result.md",
        kind: "report",
        content: Bun.file(source),
        mimeType: "text/markdown",
      })
      await fs.rm(source)

      const packet = await SessionReview.packet(session.id, {
        artifactID: first.id,
        versionID: first.currentVersionID,
      })
      expect(packet).toMatchObject({
        agent: "artifact-reviewer",
        target: {
          id: ArtifactStore.reviewTargetID(first.current.id, first.current.sha256),
          versionID: first.currentVersionID,
          sha256: first.current.sha256,
        },
      })
      expect(packet.text).toContain(ArtifactStore.reviewTargetID(first.current.id, first.current.sha256))
      expect(packet.text).toContain(first.current.sha256)
      expect(packet.text).not.toContain(second.current.sha256)

      const launched = await SessionRoutes().request(`/${session.id}/review/artifact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactID: first.id, versionID: first.currentVersionID }),
      })
      expect(launched.status).toBe(200)
      expect(await launched.json()).toMatchObject({
        started: true,
        target: {
          id: ArtifactStore.reviewTargetID(first.current.id, first.current.sha256),
          versionID: first.currentVersionID,
          sha256: first.current.sha256,
        },
      })
      const other = await Session.create({ title: "wrong source session" })
      const rejected = await SessionRoutes().request(`/${other.id}/review/artifact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactID: first.id, versionID: first.currentVersionID }),
      })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({
        error: "The review must run in the session that saved this artifact version",
      })

      const target = await Provenance.find(
        { projectID: Instance.project.id, directory: Instance.directory },
        ArtifactStore.reviewTargetID(first.current.id, first.current.sha256),
      )
      expect(target).toMatchObject({
        kind: "artifact",
        contentHash: first.current.sha256,
        size: first.current.size,
        meta: {
          artifactStore: true,
          artifactID: first.id,
          versionID: first.currentVersionID,
          version: 1,
        },
      })

      const snapshot = await ArtifactSnapshotTool.init()
      const result = await snapshot.execute(
        { target: ArtifactStore.reviewTargetID(first.current.id, first.current.sha256) },
        {
          sessionID: session.id,
          messageID: "msg_review",
          callID: "call_review",
          agent: "artifact-reviewer",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        },
      )
      expect(result.output).toContain("Measured value: 42.")
      expect(result.output).not.toContain("Measured value: 99.")
      expect(result.metadata).toMatchObject({
        target: ArtifactStore.reviewTargetID(first.current.id, first.current.sha256),
        versionID: first.currentVersionID,
        sha256: first.current.sha256,
      })
      expect(
        snapshot.execute(
          { target: ArtifactStore.reviewTargetID(first.current.id, first.current.sha256) },
          {
            sessionID: other.id,
            messageID: "msg_wrong_session",
            callID: "call_wrong_session",
            agent: "artifact-reviewer",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        ),
      ).rejects.toThrow("not an immutable artifact-store version for this session")

      const reviewer = await Agent.get("artifact-reviewer")
      const disabled = PermissionNext.disabled(
        ["artifact_snapshot", "provenance_query", "provenance_review", "read", "bash", "write", "edit", "skill"],
        reviewer.permission,
      )
      expect(disabled.has("artifact_snapshot")).toBeFalse()
      expect(disabled.has("provenance_query")).toBeFalse()
      expect(disabled.has("provenance_review")).toBeFalse()
      expect(disabled).toEqual(new Set(["read", "bash", "write", "edit", "skill"]))

      await Session.remove(other.id)
      await Session.remove(session.id)
    },
  })
})
