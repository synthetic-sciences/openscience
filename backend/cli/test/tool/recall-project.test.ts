import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { RecallTool } from "../../src/tool/recall"
import { tmpdir } from "../fixture/fixture"

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_now",
    agent: "research",
    abort: new AbortController().signal,
    messages: [] as MessageV2.WithParts[],
    metadata: () => {},
    ask: async () => {},
  }
}
async function search(sessionID: string, pattern = ".+", limit = 100) {
  const tool = await RecallTool.init()
  return tool.execute({ scope: "project", pattern, limit }, context(sessionID))
}

test("project recall is explicit, query-relevant and durable across instance reload", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const source = await Session.create({})
      await exchange(source.id, "Use ORION-9 and VisDrone", "Confirmed the codename ORION-9")
      // A later unrelated exchange must not hide an earlier matching one.
      await exchange(source.id, "Unrelated question", "Unrelated answer")
      expect((await search(source.id, "ORION")).metadata.count).toBe(0)
      await Instance.dispose()
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({})
      const tool = await RecallTool.init()
      expect((await tool.execute({ pattern: "ORION" }, context(current.id))).metadata.count).toBe(0)
      const found = await search(current.id, "orion")
      expect(found.metadata.count).toBe(2)
      expect(found.output).toContain("ORION-9")
      expect(found.output).not.toContain("Unrelated answer")
      const first = JSON.parse(found.output.split("\n")[1])
      expect(first.sessionID).not.toBe(current.id)
      expect(first.messageID).toStartWith("msg_")
      expect(first.offset).toBe(4)
      expect((await search(current.id, "absent")).metadata.count).toBe(0)
      await expect(search(current.id, "(")).rejects.toThrow("Invalid pattern")
    },
  })
})

test("project recall enforces project and directory isolation", async () => {
  await using a = await tmpdir({ git: true })
  await using b = await tmpdir({ git: true })
  await Instance.provide({
    directory: a.path,
    fn: async () => {
      const source = await Session.create({})
      await exchange(source.id, "PRIVATE_A", "PRIVATE_A_REPLY")
    },
  })
  await Instance.provide({
    directory: b.path,
    fn: async () => {
      const current = await Session.create({})
      const foreign = await Session.create({})
      await exchange(foreign.id, "FOREIGN_DIRECTORY", "FOREIGN_REPLY")
      await Storage.write(["session", Instance.project.id, foreign.id], { ...foreign, directory: a.path })
      expect((await search(current.id)).metadata.count).toBe(0)
    },
  })
})

test("excludes child, archived and reverted sessions and refreshes after deletion", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({})
      const child = await Session.create({ parentID: current.id })
      await exchange(child.id, "CHILD", "CHILD_REPLY")
      const archived = await Session.create({})
      await exchange(archived.id, "ARCHIVED", "ARCHIVED_REPLY")
      await Session.update(archived.id, (draft) => {
        draft.time.archived = 0
      })
      const reverted = await Session.create({})
      const turn = await exchange(reverted.id, "REVERTED", "REVERTED_REPLY")
      await Session.update(reverted.id, (draft) => {
        draft.revert = { messageID: turn.prompt.id }
      })
      const source = await Session.create({})
      await exchange(source.id, "VISIBLE", "VISIBLE_REPLY")
      const result = await search(current.id)
      expect(result.metadata.count).toBe(2)
      expect(result.output).toContain("VISIBLE_REPLY")
      expect((await search(child.id)).metadata.count).toBe(0)
      await Session.update(source.id, (draft) => {
        draft.time.archived = Date.now()
      })
      expect((await search(current.id)).metadata.count).toBe(0)
      await Session.update(source.id, (draft) => {
        delete draft.time.archived
      })
      expect((await search(current.id)).metadata.count).toBe(2)
      await Session.remove(source.id)
      expect((await search(current.id)).metadata.count).toBe(0)
    },
  })
})

test("only completed exchanges contribute visible text, never tools or harness data", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({})
      const source = await Session.create({})
      const good = await exchange(source.id, "VISIBLE_USER", "VISIBLE_REPLY")
      for (const options of [
        { error: new MessageV2.AbortedError({ message: "aborted" }).toObject() },
        { time: { created: Date.now() } },
        { finish: "tool-calls" },
        { summary: true },
      ])
        await exchange(source.id, "REJECTED_USER", "REJECTED_REPLY", options)
      for (const part of [
        { type: "text" as const, text: "SYNTHETIC", synthetic: true },
        { type: "text" as const, text: "IGNORED", ignored: true },
        { type: "reasoning" as const, text: "PRIVATE_REASONING", time: { start: 1, end: 2 } },
        {
          type: "tool" as const,
          tool: "bash",
          callID: "call_private",
          state: {
            status: "completed" as const,
            input: { command: "PRIVATE_INPUT" },
            output: "PRIVATE_OUTPUT",
            title: "private",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      ])
        await Session.updatePart({
          ...part,
          id: Identifier.ascending("part"),
          messageID: good.assistant.id,
          sessionID: source.id,
        })
      const hidden = await exchange(source.id, "HIDDEN_PROMPT", "HIDDEN_REPLY")
      await Session.updateMessage({
        ...hidden.prompt,
        internal: { type: "compaction", auto: true, epoch: hidden.prompt.id, transaction: "test-hidden" },
      })
      const found = await search(current.id)
      expect(found.metadata.count).toBe(2)
      expect(found.output).toContain("VISIBLE_REPLY")
      for (const excluded of ["REJECTED", "SYNTHETIC", "IGNORED", "PRIVATE_", "HIDDEN_"])
        expect(found.output).not.toContain(excluded)
    },
  })
})

test("continuation replies are paired with the original user request", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({})
      const source = await Session.create({})
      const original = await exchange(source.id, "ORIGINAL_FACT", "unfinished", { finish: "tool-calls" })
      const continued = await exchange(source.id, "INTERNAL_TEXT", "FINAL_FACT")
      await Session.updateMessage({
        ...continued.prompt,
        internal: {
          type: "continuation",
          kind: "harness",
          text: "continue",
          epoch: original.prompt.id,
          transaction: "test-continuation",
        },
      })
      const found = await search(current.id)
      expect(found.output).toContain("ORIGINAL_FACT")
      expect(found.output).toContain("FINAL_FACT")
      expect(found.output).not.toContain("INTERNAL_TEXT")
    },
  })
})

test("searches only eight recent candidates, at most four matching sessions and 32 messages each", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({})
      for (const index of Array.from({ length: 9 }, (_, index) => index)) {
        const source = await Session.create({})
        await exchange(source.id, `MATCH_${index}`, `ANSWER_${index}`)
        await Session.update(
          source.id,
          (draft) => {
            draft.time.updated = 1000 + index
          },
          { touch: false },
        )
      }
      expect((await search(current.id, "MATCH_0")).metadata.count).toBe(0)
      const recent = await search(current.id, "MATCH_")
      expect(recent.metadata.count).toBe(4)
      expect(recent.metadata.truncated).toBe(true)
      expect(recent.output).toContain("Additional matches were omitted")
      expect(recent.output).toContain("MATCH_8")
      expect(recent.output).not.toContain("MATCH_4")
      const long = await Session.create({})
      await exchange(long.id, "OLD_NEEDLE", "OLD_NEEDLE_REPLY")
      for (const index of Array.from({ length: 16 }, (_, index) => index))
        await exchange(long.id, `NEW_${index}`, `REPLY_${index}`)
      expect((await search(current.id, "OLD_NEEDLE")).metadata.count).toBe(0)
    },
  })
}, 60_000)

test("bounds UTF-8 output even for broad matches, and reports result limits", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({})
      const source = await Session.create({})
      await exchange(source.id, "研究🧪".repeat(2000), "研究🧪".repeat(2000))
      const broad = await search(current.id, ".+", 2)
      expect(broad.metadata.count).toBe(2)
      expect(broad.metadata.truncated).toBe(false)
      expect(broad.output).not.toContain("Additional matches were omitted")
      expect(Buffer.byteLength(broad.output)).toBeLessThanOrEqual(16 * 1024)
      expect(broad.output).not.toContain("�")
      const many = await search(current.id, "研究")
      expect(many.metadata.truncated).toBe(true)
      expect(many.output).toContain("Additional matches were omitted")
      expect(Buffer.byteLength(many.output)).toBeLessThanOrEqual(16 * 1024)
      const limited = await search(current.id, "研究", 1)
      expect(limited.metadata.count).toBe(1)
      expect(limited.metadata.truncated).toBe(true)
      expect(limited.output).toContain("Additional matches were omitted")
      expect((await search(current.id, "(?=研究)", 1)).metadata.count).toBe(1)
    },
  })
})

test("excerpts distinguish normalized whitespace from omitted text and respect the scan boundary", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({})
      const source = await Session.create({})
      await exchange(source.id, "needle     here", "x".repeat(65_534) + "Z🧪OUTSIDE")
      const short = await search(current.id, "needle")
      expect(JSON.parse(short.output.split("\n")[1]).excerpt).toBe("needle here")
      const boundary = await search(current.id, "Z")
      expect(JSON.parse(boundary.output.split("\n")[1]).excerpt).toBe("…" + "x".repeat(80) + "Z")
      expect((await search(current.id, "OUTSIDE")).metadata.count).toBe(0)
    },
  })
})

test.each(["OPENSCIENCE_DISABLE_PROJECT_MEMORY", "OPENSCIENCE_DISABLE_PROJECT_CONFIG"])(
  "%s disables project recall without affecting current-session recall",
  async (flag) => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await Session.create({})
        await exchange(source.id, "SAVED_USER", "SAVED_REPLY")
        const current = await Session.create({})
        await exchange(current.id, "CURRENT_USER", "CURRENT_REPLY")
        const previous = process.env[flag]
        process.env[flag] = "1"
        try {
          expect((await search(current.id)).output).toContain("disabled")
          const tool = await RecallTool.init()
          expect((await tool.execute({ pattern: "CURRENT_REPLY" }, context(current.id))).metadata.count).toBe(1)
        } finally {
          if (previous === undefined) delete process.env[flag]
          else process.env[flag] = previous
        }
        expect((await search(current.id, "SAVED_REPLY")).metadata.count).toBe(1)
      },
    })
  },
)
async function exchange(sessionID: string, user: string, answer: string, options: Partial<MessageV2.Assistant> = {}) {
  const prompt: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "research",
    model: { providerID: "test", modelID: "test" },
    effort: "normal",
  }
  await Session.updateMessage(prompt)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: prompt.id,
    type: "text",
    text: user,
  })
  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: prompt.id,
    time: { created: Date.now(), completed: Date.now() },
    mode: "research",
    agent: "research",
    modelID: "test",
    providerID: "test",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...options,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: assistant.id,
    type: "text",
    text: answer,
  })
  return { prompt, assistant }
}
