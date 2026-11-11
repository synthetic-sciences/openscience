import { expect, test } from "bun:test"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { ArtifactTool } from "../../src/tool/artifact"
import { TaskEvidence } from "../../src/tool/task-evidence"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

test("Task hands back only this turn's immutable child outputs, readable by the parent without scratch access", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      const ctx = {
        sessionID: child.id,
        messageID: "msg_old",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      }
      const source = path.join(await SessionFilesystem.workspace(child.id), "report.md")
      const content = "α".repeat(25_599) + "🧬" + "important final evidence".repeat(500)
      await Bun.write(source, "old report")
      const tool = await ArtifactTool.init()
      await tool.execute({ action: "save_file", path: source }, ctx)
      await Bun.write(source, content)
      await tool.execute({ action: "save_file", path: source }, { ...ctx, messageID: "msg_new" })
      await Bun.write(source, "later mutable scratch must not change handoff")
      const msg = (id: string): MessageV2.WithParts => ({
        info: {
          id,
          sessionID: child.id,
          role: "user",
          agent: "research",
          effort: "normal",
          model: { providerID: "fixture", modelID: "offline" },
          time: { created: 1 },
        },
        parts: [],
      })
      const changed = ["application.py", "backend.py", "campaign.py", "matrix.py"].map((file) =>
        path.join(tmp.path, file),
      )
      const deleted = path.join(tmp.path, "obsolete.py")
      const movedFrom = path.join(tmp.path, "draft.py")
      const movedTo = path.join(tmp.path, "final.py")
      const mutationMessage: MessageV2.WithParts = {
        info: {
          id: "msg_mutations",
          sessionID: child.id,
          role: "assistant",
          parentID: "msg_new",
          mode: "execute",
          agent: "execute",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "offline",
          providerID: "fixture",
          time: { created: 2, completed: 3 },
          finish: "tool-calls",
        },
        parts: [
          {
            id: "prt_patch_one",
            sessionID: child.id,
            messageID: "msg_mutations",
            type: "tool",
            tool: "apply_patch",
            callID: "call_patch_one",
            state: {
              status: "completed",
              input: {},
              title: "Updated application and backend",
              output: "Success",
              metadata: {
                files: [
                  { filePath: changed[0], relativePath: "application.py" },
                  { filePath: changed[1], relativePath: "backend.py" },
                ],
              },
              time: { start: 2, end: 2 },
            },
          },
          {
            id: "prt_patch_two",
            sessionID: child.id,
            messageID: "msg_mutations",
            type: "tool",
            tool: "apply_patch",
            callID: "call_patch_two",
            state: {
              status: "completed",
              input: {},
              title: "Updated campaign and matrix",
              output: "Success",
              metadata: {
                files: [
                  { filePath: changed[2], relativePath: "campaign.py" },
                  { filePath: changed[3], relativePath: "matrix.py" },
                  { filePath: deleted, relativePath: "obsolete.py", type: "delete" },
                  { filePath: movedFrom, relativePath: "draft.py", movePath: movedTo, type: "move" },
                ],
              },
              time: { start: 2, end: 3 },
            },
          },
        ],
      }
      const evidence = await TaskEvidence.collect({
        projectID: Instance.project.id,
        sessionID: child.id,
        messages: [msg("msg_old"), msg("msg_new"), mutationMessage],
        previous: new Set(["msg_old"]),
      })
      expect(evidence.artifacts).toHaveLength(1)
      const artifact = evidence.artifacts[0]
      expect(evidence.mutations).toHaveLength(2)
      expect(evidence.mutations.flatMap((receipt) => receipt.files)).toEqual([...changed, movedTo])
      expect(evidence.mutations.flatMap((receipt) => receipt.removed)).toEqual([deleted, movedFrom])
      const description = TaskEvidence.describe(evidence)
      expect(description).toContain(artifact.versionID)
      expect(description).toContain("5 unique files across 2 successful mutation calls")
      expect(description).toContain(JSON.stringify(changed[3]))
      expect(description).toContain(JSON.stringify(movedTo))
      expect(description).not.toContain(JSON.stringify(deleted))
      expect(description).not.toContain(JSON.stringify(movedFrom))
      await expect(
        SessionFilesystem.authorize({ sessionID: parent.id, path: source, access: "read" }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      const params = { action: "read_file" as const, artifact_id: artifact.artifactID, version_id: artifact.versionID }
      const read = await tool.execute(params, { ...ctx, sessionID: parent.id })
      expect(read.metadata.sha256).toBe(artifact.sha256)
      expect(read.metadata.nextOffset).toBe(51_198)
      const rest = await tool.execute(
        { ...params, offset: read.metadata.nextOffset as number },
        { ...ctx, sessionID: parent.id },
      )
      expect(read.output.split("\n\n[More content:")[0] + rest.output).toBe(content)
      await expect(tool.execute({ ...params, version_id: "foreign-version" }, ctx)).rejects.toThrow("unavailable")
      await expect(tool.execute({ action: "read_file", artifact_id: artifact.artifactID }, ctx)).rejects.toThrow(
        "invalid arguments",
      )
      expect(await ArtifactStore.read("another-project", artifact.artifactID, artifact.versionID)).toBeUndefined()
      await Session.remove(child.id)
      await Session.remove(parent.id)
    },
  })
})

test("shell writes are read from the command text: redirects, tee and heredocs, not devices or stdin", () => {
  expect(
    TaskEvidence.shellWrites("cat > /tmp/Interp.lean <<'EOF'\nimport Mathlib\nEOF\nlake env lean /tmp/Interp.lean"),
  ).toEqual(["/tmp/Interp.lean"])
  expect(
    TaskEvidence.shellWrites("python train.py 2>&1 | tee logs/run.log && echo done >> results/summary.txt"),
  ).toEqual(["results/summary.txt", "logs/run.log"])
  expect(TaskEvidence.shellWrites("grep -c sorry src/*.lean; ls > /dev/null; echo $x 2>/dev/null")).toEqual([])
  expect(TaskEvidence.shellWrites("python3 - <<'PY'\nprint(1)\nPY")).toEqual([])
})
