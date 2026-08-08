import { expect, test } from "bun:test"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
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
      const target = path.join(tmp.path, "results", "titanic-report.md")
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

      expect(first.title).toBe("Saved artifact: Titanic analysis report")
      expect(first.metadata.savedArtifact).toMatchObject({
        version: 1,
        title: "Titanic analysis report",
        kind: "report",
        path: "results/titanic-report.md",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(second.metadata.savedArtifact).toMatchObject({
        id: firstSaved.id,
        version: 2,
      })
      expect(await ArtifactStore.list(Instance.project.id)).toHaveLength(1)
      expect(await ArtifactStore.get(Instance.project.id, firstSaved.id)).toMatchObject({ versionCount: 2 })
    },
  })
})
