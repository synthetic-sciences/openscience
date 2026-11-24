import { describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import type { Provider } from "../../../src/provider/provider"
import { Session } from "../../../src/session"
import { SessionCompaction } from "../../../src/session/compaction"
import { ForeignConvert } from "../../../src/session/foreign/convert"
import { Provenance } from "../../../src/session/foreign/provenance"
import type { ForeignConversation, ForeignEntry } from "../../../src/session/foreign/types"
import { MessageV2 } from "../../../src/session/message-v2"
import { Log } from "../../../src/util/log"
import { tmpdir } from "../../fixture/fixture"

Log.init({ print: false })

const model = {
  id: "test-model",
  providerID: "test",
  name: "Test",
  limit: { context: 200_000, output: 32_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: true,
    reasoning: false,
    temperature: true,
    input: { text: true, image: true, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/anthropic" },
  options: {},
} as unknown as Provider.Model

async function withSession<T>(fn: (session: Session.Info, dir: string) => Promise<T>) {
  await using tmp = await tmpdir()
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      return fn(session, tmp.path).finally(() => Session.remove(session.id))
    },
  })
}

function conversation(source: "claude" | "codex", entries: ForeignEntry[]): ForeignConversation {
  return {
    info: { source, id: "src-1", path: "/x/src-1.jsonl", cwd: "/work", created: 1, modified: 2 },
    entries,
    branchIDs: entries.map((entry) => entry.sourceID),
  }
}
const say = (sourceID: string, role: "user" | "assistant", text: string, time = 1): ForeignEntry => ({
  sourceID,
  role,
  time,
  model: role === "assistant" ? "claude-sonnet-5" : undefined,
  parts: [{ type: "text", text }],
})

async function write(session: Session.Info, dir: string, c: ForeignConversation, from?: number) {
  const result = await ForeignConvert.write({
    sessionID: session.id,
    conversation: c,
    from,
    cwd: dir,
    root: dir,
    agent: "research",
  })
  await Session.flushPendingParts(session.id)
  return result
}

describe("ForeignConvert.toolName", () => {
  test("maps known tools and cleans unknown names", () => {
    expect(ForeignConvert.toolName("claude", "Bash")).toBe("bash")
    expect(ForeignConvert.toolName("claude", "Read")).toBe("read")
    expect(ForeignConvert.toolName("claude", "Edit")).toBe("edit")
    expect(ForeignConvert.toolName("claude", "TodoWrite")).toBe("todowrite")
    expect(ForeignConvert.toolName("claude", "Task")).toBe("task")
    expect(ForeignConvert.toolName("claude", "Agent")).toBe("task")
    expect(ForeignConvert.toolName("codex", "shell")).toBe("bash")
    expect(ForeignConvert.toolName("claude", "mcp__github.get issue")).toBe("mcp__github_get_issue")
    expect(ForeignConvert.toolName("claude", "a".repeat(70))).toHaveLength(64)
  })
})

describe("ForeignConvert.write", () => {
  test("writes turns as user and assistant messages with $0 cost and stamped model", async () => {
    await withSession(async (session, dir) => {
      const result = await write(
        session,
        dir,
        conversation("claude", [say("u1", "user", "hello"), say("a1", "assistant", "hi there", 2)]),
      )
      expect(result).toMatchObject({ written: 2, lastSourceID: "a1" })
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages.map((m) => m.info.role)).toEqual(["user", "assistant"])
      const reply = messages[1].info as MessageV2.Assistant
      expect(reply.providerID).toBe("claude-code")
      expect(reply.modelID).toBe("claude-sonnet-5")
      expect(reply.cost).toBe(0)
      expect(reply.summary).toBeUndefined()
      expect(messages.flatMap((m) => m.parts).every((p) => !("metadata" in p) || p.metadata === undefined)).toBe(true)
      expect(result.lastMessageID).toBe(reply.id)
    })
  })

  test("assistant messages have parentID and time.completed", async () => {
    await withSession(async (session, dir) => {
      await write(session, dir, conversation("codex", [say("u1", "user", "q"), say("a1", "assistant", "a", 5)]))
      const [user, reply] = await Session.messages({ sessionID: session.id })
      const info = reply.info as MessageV2.Assistant
      expect(info.parentID).toBe(user.info.id)
      expect(info.time.completed).toBe(5)
      expect(info.providerID).toBe("codex")
    })
  })

  test("keeps reasoning as display parts only", async () => {
    await withSession(async (session, dir) => {
      await write(
        session,
        dir,
        conversation("claude", [
          say("u1", "user", "q"),
          {
            sourceID: "a1",
            role: "assistant",
            time: 2,
            parts: [
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "a" },
            ],
          },
        ]),
      )
      const parts = (await Session.messages({ sessionID: session.id }))[1].parts
      const reasoning = parts.find((p) => p.type === "reasoning") as MessageV2.ReasoningPart
      expect(reasoning.text).toBe("thinking")
      expect(reasoning.metadata).toBeUndefined()
    })
  })

  test("writes a tool call with no result as completed", async () => {
    await withSession(async (session, dir) => {
      await write(
        session,
        dir,
        conversation("claude", [
          say("u1", "user", "q"),
          {
            sourceID: "a1",
            role: "assistant",
            time: 2,
            parts: [{ type: "tool", callID: "c1", name: "Read", input: { file_path: "/a.txt" } }],
          },
          say("u2", "user", "never mind"),
        ]),
      )
      const tool = (await Session.messages({ sessionID: session.id }))[1].parts[0] as MessageV2.ToolPart
      expect(tool.tool).toBe("read")
      expect(tool.state).toMatchObject({
        status: "completed",
        output: "(no result recorded)",
        input: { filePath: "/a.txt" },
      })
    })
  })

  test("reshapes TodoWrite input and keeps tool_result images as attachments", async () => {
    await withSession(async (session, dir) => {
      await write(
        session,
        dir,
        conversation("claude", [
          say("u1", "user", "q"),
          {
            sourceID: "a1",
            role: "assistant",
            time: 2,
            parts: [
              {
                type: "tool",
                callID: "c1",
                name: "TodoWrite",
                input: { todos: [{ content: "Do it", status: "pending", activeForm: "Doing it" }] },
                output: "ok",
              },
              {
                type: "tool",
                callID: "c2",
                name: "Read",
                input: { file_path: "/p.png" },
                output: "",
                attachments: [{ mime: "image/png", data: "iVBORw0KGgo=" }],
              },
            ],
          },
        ]),
      )
      const [todo, read] = (await Session.messages({ sessionID: session.id }))[1].parts as MessageV2.ToolPart[]
      expect(todo.state.input).toEqual({
        todos: [{ id: "1", content: "Do it", status: "pending", priority: "medium" }],
      })
      const state = read.state as MessageV2.ToolStateCompleted
      expect(state.attachments?.[0]).toMatchObject({
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,iVBORw0KGgo=",
      })
    })
  })

  test("writes Task as a task part whose handoff survives pruning", async () => {
    await withSession(async (session, dir) => {
      const bulk = "x".repeat(4 * (SessionCompaction.PRUNE_PROTECT + SessionCompaction.PRUNE_MINIMUM) * 2)
      await write(
        session,
        dir,
        conversation("claude", [
          say("u1", "user", "delegate"),
          {
            sourceID: "a1",
            role: "assistant",
            time: 2,
            parts: [
              {
                type: "tool",
                callID: "t1",
                name: "Task",
                input: { description: "look", prompt: "look around" },
                output: "WORKER FOUND THE BUG",
                subagentResult: "WORKER FOUND THE BUG",
              },
              { type: "tool", callID: "b1", name: "Bash", input: { command: "cat big" }, output: bulk },
              { type: "tool", callID: "b2", name: "Bash", input: { command: "cat big2" }, output: bulk },
            ],
          },
          say("u2", "user", "continue"),
          say("a2", "assistant", "ok", 3),
        ]),
      )
      const task = (await Session.messages({ sessionID: session.id }))[1].parts[0] as MessageV2.ToolPart
      expect(task.tool).toBe("task")
      expect((task.state as MessageV2.ToolStateCompleted).metadata).toEqual({ handoff: "WORKER FOUND THE BUG" })
      const pruned = await SessionCompaction.prune({ sessionID: session.id })
      expect(pruned).toBeGreaterThan(0)
      const after = await Session.messages({ sessionID: session.id })
      const prunedTask = after[1].parts[0] as MessageV2.ToolPart
      expect((prunedTask.state as MessageV2.ToolStateCompleted).time.compacted).toBeDefined()
      const wire = JSON.stringify(MessageV2.toModelMessages(after, model))
      expect(wire).toContain("WORKER FOUND THE BUG")
    })
  })

  test("writes a compaction as a boundary", async () => {
    await withSession(async (session, dir) => {
      await write(
        session,
        dir,
        conversation("claude", [
          say("u1", "user", "early question"),
          say("a1", "assistant", "early answer", 2),
          { kind: "compaction", sourceID: "s1", time: 3, summary: "Summary of the early work." },
          say("u2", "user", "later question", 4),
          say("a2", "assistant", "later answer", 5),
        ]),
      )
      const messages = await Session.messages({ sessionID: session.id })
      const carrier = messages[2]
      const compaction = carrier.parts.find((p) => p.type === "compaction") as MessageV2.CompactionPart
      expect(compaction).toMatchObject({ auto: false, trigger: "manual" })
      const summary = messages[3].info as MessageV2.Assistant
      expect(summary).toMatchObject({ summary: true, finish: "stop", parentID: carrier.info.id })
      const view = await MessageV2.filterCompacted(MessageV2.stream(session.id))
      const texts = view.flatMap((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => (p as MessageV2.TextPart).text),
      )
      expect(texts).toEqual(["Summary of the early work.", "later question", "later answer"])
    })
  })

  test("stores the Codex compaction item under its own key and reads it back", async () => {
    await withSession(async (session, dir) => {
      const item = { type: "compaction", encrypted_content: "ENC" }
      await write(
        session,
        dir,
        conversation("codex", [
          say("u1", "user", "q"),
          say("a1", "assistant", "a", 2),
          {
            kind: "compaction",
            sourceID: "codex:9",
            time: 3,
            summary: "Context compacted by Codex.",
            codex: { item, keptUserMessages: ["q"] },
          },
        ]),
      )
      const records = await ForeignConvert.codexCompactions(session.id)
      expect(records).toHaveLength(1)
      expect(records[0]).toEqual({ item, summaryText: "Context compacted by Codex.", keptUserMessages: ["q"] })
    })
  })

  test("appends from an index without rewriting earlier entries", async () => {
    await withSession(async (session, dir) => {
      const c = conversation("claude", [
        say("u1", "user", "q"),
        say("a1", "assistant", "a", 2),
        say("u2", "user", "q2", 3),
        say("a2", "assistant", "a2", 4),
      ])
      await write(session, dir, { ...c, entries: c.entries.slice(0, 2) })
      const result = await write(session, dir, c, 2)
      expect(result).toMatchObject({ written: 2, lastSourceID: "a2" })
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages.map((m) => m.info.role)).toEqual(["user", "assistant", "user", "assistant"])
      expect((messages[3].info as MessageV2.Assistant).parentID).toBe(messages[2].info.id)
    })
  })
})

describe("Provenance", () => {
  test("provenance round-trips and is found by source", async () => {
    await withSession(async (session) => {
      const record: Provenance.Record = {
        source: "claude",
        sourceID: "src-1",
        path: "/x/src-1.jsonl",
        cwd: "/work",
        branchIDs: ["u1", "a1"],
        lastSourceID: "a1",
        lastMessageID: "msg_x",
        importedAt: 10,
      }
      await Provenance.write(session.id, record)
      expect(await Provenance.read(session.id)).toEqual(record)
      expect(await Provenance.findBySource("claude", "src-1")).toEqual([session.id])
      expect(await Provenance.findBySource("codex", "src-1")).toEqual([])
    })
  })

  test("a notice is written as a synthetic harness note with its label", async () => {
    await withSession(async (session, dir) => {
      await write(
        session,
        dir,
        conversation("claude", [
          say("u1", "user", "go"),
          say("a1", "assistant", "started", 2),
          {
            sourceID: "n1",
            role: "user",
            time: 3,
            parts: [{ type: "text", text: "<task-notification>…</task-notification>", notice: "Job finished" }],
          },
          say("a2", "assistant", "ok", 4),
        ]),
      )
      const part = (await Session.messages({ sessionID: session.id }))[2].parts[0] as MessageV2.TextPart
      expect(part).toMatchObject({
        type: "text",
        synthetic: true,
        metadata: { "openscience.wake": { label: "Job finished" } },
      })
      expect(part.text).toBe("<task-notification>…</task-notification>")
    })
  })
})
