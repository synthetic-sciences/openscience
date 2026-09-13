import { describe, expect, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import type { MessageV2 } from "../../src/session/message-v2"
import { RecallTool } from "../../src/tool/recall"
import { Truncate } from "../../src/tool/truncation"
import { tmpdir } from "../fixture/fixture"

function context(sessionID: string, messageID = "msg_now") {
  return {
    sessionID,
    messageID,
    callID: "call_recall",
    agent: "research",
    abort: new AbortController().signal,
    messages: [] as MessageV2.WithParts[],
    metadata: () => {},
    ask: async () => {},
  }
}

async function seed(sessionID: string, root: string) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "research",
    model: { providerID: "test", modelID: "test-model" },
    effort: "normal",
  })
  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    modelID: "test-model",
    providerID: "test",
    mode: "research",
    agent: "research",
    path: { cwd: root, root },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "tool-calls",
    time: { created: 2, completed: 3 },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: assistant.id,
    type: "tool",
    tool: "bash",
    callID: "call_fit",
    state: {
      status: "completed",
      input: { command: "python fit.py" },
      title: "python fit.py",
      output: "fit converged: slope=2.9987 intercept=2.0113 val_mse=0.0102",
      metadata: {},
      // Pruned out of the model context; the store still has it.
      time: { start: 1, end: 2, compacted: 5 },
    },
  })
  await Session.flushPendingParts(sessionID)
}

describe("recall", () => {
  test("finds a value in a pruned tool result and in a saved tool output, with offsets", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await seed(session.id, tmp.path)
        // A full tool output the broker saved and granted to this session.
        const saved = await Truncate.output(
          Array.from({ length: 5_000 }, (_, i) => `line ${i} ${i === 4_321 ? "checkpoint_hash=abc123" : ""}`).join(
            "\n",
          ),
          { sessionID: session.id },
        )
        expect(saved.truncated).toBe(true)
        const tool = await RecallTool.init()
        const history = await tool.execute({ pattern: "val_mse=([0-9.]+)" }, context(session.id))
        expect(history.metadata.count).toBe(1)
        expect(history.output).toContain("bash result (call_fit)")
        expect(history.output).toMatch(/@\d+: /)
        expect(history.output).toContain("val_mse=0.0102")

        const outputs = await tool.execute({ pattern: "checkpoint_hash=\\w+", scope: "outputs" }, context(session.id))
        expect(outputs.metadata.count).toBe(1)
        expect(outputs.output).toContain("saved output")
        expect(outputs.output).toContain("checkpoint_hash=abc123")

        const none = await tool.execute({ pattern: "never_written_anywhere" }, context(session.id))
        expect(none.metadata.count).toBe(0)
        await expect(tool.execute({ pattern: "(" }, context(session.id))).rejects.toThrow(/Invalid pattern/)
      },
    })
  })

  test("respects the session boundary: another session's saved outputs are not searched", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const mine = await Session.create({})
        const other = await Session.create({})
        const saved = await Truncate.output(
          Array.from({ length: 5_000 }, (_, i) => `row ${i} ${i === 10 ? "private_token=zzz" : ""}`).join("\n"),
          { sessionID: other.id },
        )
        expect(saved.truncated).toBe(true)
        if (!saved.truncated) throw new Error("expected a saved output")
        expect(
          (await SessionFilesystem.list(other.id)).some(
            (grant) => grant.source === "tool" && grant.path.includes(path.basename(saved.outputPath)),
          ),
        ).toBe(true)
        const tool = await RecallTool.init()
        const result = await tool.execute({ pattern: "private_token" }, context(mine.id))
        expect(result.metadata.count).toBe(0)
      },
    })
  })
})
