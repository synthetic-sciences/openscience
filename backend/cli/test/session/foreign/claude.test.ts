import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClaudeReader } from "../../../src/session/foreign/claude"
import type { ForeignConversation, ForeignTurn } from "../../../src/session/foreign/types"

// Synthetic Claude Code transcripts. Field names follow real Claude Code
// records (uuid/parentUuid, isSidechain, isMeta, compact_boundary with
// logicalParentUuid, isCompactSummary, message.id/stop_reason/usage).
let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "os-claude-import-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const t0 = Date.parse("2026-11-01T10:00:00Z")
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString()

function user(
  uuid: string,
  parent: string | null,
  content: unknown,
  seconds: number,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "user",
    uuid,
    parentUuid: parent,
    cwd: "/work/proj",
    sessionId: "s",
    timestamp: at(seconds),
    message: { role: "user", content },
    ...extra,
  }
}
function assistant(
  uuid: string,
  parent: string | null,
  content: unknown[],
  seconds: number,
  opts: { id?: string; stop?: string | null; usage?: Record<string, number>; extra?: Record<string, unknown> } = {},
) {
  return {
    type: "assistant",
    uuid,
    parentUuid: parent,
    cwd: "/work/proj",
    sessionId: "s",
    timestamp: at(seconds),
    message: {
      id: opts.id ?? `msg_${uuid}`,
      role: "assistant",
      model: "claude-sonnet-5",
      content,
      stop_reason: opts.stop === undefined ? "end_turn" : opts.stop,
      usage: opts.usage ?? { input_tokens: 10, output_tokens: 5 },
    },
    ...(opts.extra ?? {}),
  }
}
const text = (value: string) => ({ type: "text", text: value })

async function write(name: string, records: unknown[], slug = "-work-proj", tail = "") {
  const dir = path.join(root, slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${name}.jsonl`)
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n" + tail)
  return file
}

async function load(name: string): Promise<ForeignConversation> {
  const reader = ClaudeReader.create(root)
  const info = (await reader.list()).find((item) => item.id === name)
  if (!info) throw new Error(`fixture ${name} not listed`)
  return reader.load(info)
}
const turns = (c: ForeignConversation) => c.entries.filter((e): e is ForeignTurn => !("kind" in e))
const texts = (c: ForeignConversation) =>
  turns(c).map(
    (t) =>
      `${t.role}:${t.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("|")}`,
  )

describe("ClaudeReader", () => {
  test("lists sessions newest first with folder and first message", async () => {
    await write("older", [user("u1", null, "first question", 0), assistant("a1", "u1", [text("answer")], 1)])
    await write("newer", [
      { type: "ai-title", aiTitle: "A generated title", sessionId: "newer" },
      user("u1", null, "second question", 100),
      assistant("a1", "u1", [text("answer")], 101),
    ])
    const list = await ClaudeReader.create(root).list()
    expect(list.map((s) => s.id)).toEqual(["newer", "older"])
    expect(list[0].cwd).toBe("/work/proj")
    expect(list[0].firstMessage).toBe("second question")
    expect(list[0].title).toBe("A generated title")
    expect(list[1].source).toBe("claude")
  })

  test("follows the branch ending at the latest record", async () => {
    await write("branch", [
      user("u1", null, "start", 0),
      assistant("a1", "u1", [text("reply one")], 1),
      user("u2old", "a1", "abandoned prompt", 2),
      assistant("a2old", "u2old", [text("abandoned reply")], 3),
      user("u2new", "a1", "edited prompt", 10),
      assistant("a2new", "u2new", [text("kept reply")], 11),
    ])
    const c = await load("branch")
    expect(texts(c)).toEqual(["user:start", "assistant:reply one", "user:edited prompt", "assistant:kept reply"])
    expect(c.branchIDs).toEqual(["u1", "a1", "u2new", "a2new"])
  })

  test("keeps a subagent's result and drops sidechain records", async () => {
    await write("sidechain", [
      user("u1", null, "delegate it", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "call_task", name: "Task", input: { description: "look" } }], 1, {
        stop: "tool_use",
      }),
      user("s1", "a1", "worker prompt", 2, { isSidechain: true }),
      assistant("s2", "s1", [text("worker internal step")], 3, { extra: { isSidechain: true } }),
      user("u2", "a1", [{ type: "tool_result", tool_use_id: "call_task", content: [text("worker found X")] }], 4),
      assistant("a2", "u2", [text("done")], 5),
    ])
    const c = await load("sidechain")
    const all = JSON.stringify(c.entries)
    expect(all).not.toContain("worker internal step")
    expect(all).not.toContain("worker prompt")
    const task = turns(c)
      .flatMap((t) => t.parts)
      .find((p) => p.type === "tool")
    expect(task).toMatchObject({
      name: "Task",
      callID: "call_task",
      subagentResult: "worker found X",
      output: "worker found X",
    })
  })

  test("imports history across a compaction", async () => {
    await write("compacted", [
      user("u1", null, "early question", 0),
      assistant("a1", "u1", [text("early answer")], 1),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        parentUuid: null,
        logicalParentUuid: "a1",
        timestamp: at(50),
        compactMetadata: { trigger: "auto" },
      },
      user("sum", "b1", "Summary of the earlier conversation.", 51, { isCompactSummary: true }),
      user("u2", "sum", "later question", 60),
      assistant("a2", "u2", [text("later answer")], 61),
    ])
    const c = await load("compacted")
    const kinds = c.entries.map((e) => ("kind" in e ? `compaction:${e.summary}` : `${e.role}`))
    expect(kinds).toEqual(["user", "assistant", "compaction:Summary of the earlier conversation.", "user", "assistant"])
    expect(texts(c)).toEqual([
      "user:early question",
      "assistant:early answer",
      "user:later question",
      "assistant:later answer",
    ])
    expect(c.branchIDs).toEqual(["u1", "a1", "b1", "sum", "u2", "a2"])
  })

  test("skips isMeta, unknown record types and a half-written last line", async () => {
    await write("unknown", [
      { type: "file-history-snapshot", snapshot: {} },
      user("m1", null, "meta caveat", 0, { isMeta: true }),
      user("u1", "m1", "real question", 1),
      { type: "queue-operation", operation: "enqueue" },
      assistant("a1", "u1", [text("answer")], 2),
    ])
    await write(
      "partial",
      [user("u1", null, "q", 0), assistant("a1", "u1", [text("a")], 1)],
      "-work-proj",
      '{"type":"user","uuid":"u2","par',
    )
    expect(texts(await load("unknown"))).toEqual(["user:real question", "assistant:answer"])
    expect(texts(await load("partial"))).toEqual(["user:q", "assistant:a"])
  })

  test("pairs tool_use with tool_result and marks errors", async () => {
    await write("tools", [
      user("u1", null, "run it", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "false" } }], 1, {
        stop: "tool_use",
      }),
      user("u2", "a1", [{ type: "tool_result", tool_use_id: "c1", content: "exit 1", is_error: true }], 2),
      assistant("a2", "u2", [text("it failed")], 3),
    ])
    const c = await load("tools")
    expect(turns(c).map((t) => t.role)).toEqual(["user", "assistant", "assistant"])
    const tool = turns(c)[1].parts[0]
    expect(tool).toMatchObject({
      type: "tool",
      name: "Bash",
      input: { command: "false" },
      output: "exit 1",
      isError: true,
    })
  })

  test("list reads only head and tail of large files", async () => {
    const filler = "x".repeat(100_000)
    const records: unknown[] = [user("u1", null, "big session", 0)]
    for (let i = 0; i < 200; i++) records.push(assistant(`a${i}`, i === 0 ? "u1" : `a${i - 1}`, [text(filler)], i + 1))
    const file = await write("large", records)
    const size = (await fs.stat(file)).size
    expect(size).toBeGreaterThan(20_000_000)
    const stats = ClaudeReader.readStats()
    stats.bytes = 0
    const info = (await ClaudeReader.create(root).list()).find((s) => s.id === "large")
    expect(info?.firstMessage).toBe("big session")
    expect(stats.bytes).toBeLessThan(size / 10)
  })

  test("merges records with one message.id and drops injected command wrappers", async () => {
    await write("merge", [
      user("w1", null, "<command-name>/clear</command-name>", 0),
      user("w2", "w1", "<local-command-stdout>cleared</local-command-stdout>", 1),
      user("u1", "w2", "real prompt", 2),
      assistant("a1", "u1", [{ type: "thinking", thinking: "hmm", signature: "sig" }], 3, {
        id: "msg_same",
        stop: null,
        usage: { input_tokens: 100, output_tokens: 7 },
      }),
      assistant("a1b", "a1", [text("merged answer")], 4, {
        id: "msg_same",
        usage: { input_tokens: 100, output_tokens: 7 },
      }),
    ])
    const c = await load("merge")
    expect(texts(c)).toEqual(["user:real prompt", "assistant:merged answer"])
    const reply = turns(c)[1]
    expect(reply.parts.map((p) => p.type)).toEqual(["reasoning", "text"])
    expect(reply.sourceID).toBe("a1b")
    expect(reply.tokens).toMatchObject({ input: 100, output: 7 })
  })

  test("skips a trailing incomplete turn but keeps an interrupted earlier one", async () => {
    await write("incomplete", [
      user("u1", null, "first", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "a" } }], 1, {
        stop: "tool_use",
      }),
      user("u2", "a1", "never mind, do this instead", 2),
      assistant("a2", "u2", [text("ok")], 3),
      user("u3", "a2", "next", 4),
      assistant("a3", "u3", [{ type: "tool_use", id: "c3", name: "Bash", input: { command: "ls" } }], 5, {
        stop: "tool_use",
      }),
    ])
    const c = await load("incomplete")
    expect(turns(c).map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant", "user"])
    const interrupted = turns(c)[1].parts[0]
    expect(interrupted).toMatchObject({ type: "tool", callID: "c1" })
    expect((interrupted as { output?: string }).output).toBeUndefined()
    expect(JSON.stringify(c.entries)).not.toContain("c3")
  })

  test("keeps images from tool_result content", async () => {
    await write("image", [
      user("u1", null, "look at the plot", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "plot.png" } }], 1, {
        stop: "tool_use",
      }),
      user(
        "u2",
        "a1",
        [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }],
          },
        ],
        2,
      ),
      assistant("a2", "u2", [text("nice plot")], 3),
    ])
    const tool = turns(await load("image"))[1].parts[0]
    expect(tool).toMatchObject({ type: "tool", attachments: [{ mime: "image/png", data: "iVBORw0KGgo=" }] })
  })

  test("drops whitespace-only text blocks", async () => {
    await write("blank", [
      user("u1", null, "go", 0),
      assistant("a1", "u1", [text("\n\n"), { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }], 1, {
        stop: "tool_use",
      }),
      user("u2", "a1", [{ type: "tool_result", tool_use_id: "c1", content: "a" }], 2),
      assistant("a2", "u2", [text("done")], 3),
    ])
    const reply = turns(await load("blank"))[1]
    expect(reply.parts.map((p) => p.type)).toEqual(["tool"])
  })

  test("keeps the trailing turn of a finished file", async () => {
    const file = await write("finished", [
      user("u1", null, "first", 0),
      assistant("a1", "u1", [text("partial answer")], 1, { stop: null }),
    ])
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await fs.utimes(file, old, old)
    expect(texts(await load("finished"))).toEqual(["user:first", "assistant:partial answer"])
  })

  test("an unreadable file does not break listing", async () => {
    await write("good", [user("u1", null, "q", 0), assistant("a1", "u1", [text("a")], 1)])
    const bad = await write("bad", [user("u1", null, "q", 0)])
    await fs.chmod(bad, 0)
    try {
      expect((await ClaudeReader.create(root).list()).map((s) => s.id)).toEqual(["good"])
    } finally {
      await fs.chmod(bad, 0o644)
    }
  })

  test("caps the listed first message", async () => {
    await write("long", [user("u1", null, "y".repeat(5000), 0), assistant("a1", "u1", [text("a")], 1)])
    const info = (await ClaudeReader.create(root).list())[0]
    expect(info.firstMessage!.length).toBeLessThanOrEqual(200)
  })

  test("a task notification becomes a labelled harness note, not a typed message", async () => {
    const note = [
      "<task-notification>",
      "<task-id>b1</task-id>",
      "<tool-use-id>c9</tool-use-id>",
      "<status>completed</status>",
      '<summary>Background command "Run the suite" completed (exit code 0)</summary>',
      "</task-notification>",
    ].join("\n")
    await write("notify", [
      user("u1", null, "start the suite", 0),
      assistant("a1", "u1", [text("started")], 1),
      user("n1", "a1", note, 2),
      assistant("a2", "n1", [text("it passed")], 3),
    ])
    const c = await load("notify")
    const noticeTurn = turns(c)[2]
    expect(noticeTurn.role).toBe("user")
    expect(noticeTurn.parts).toEqual([
      { type: "text", text: note, notice: 'Background command "Run the suite" completed (exit code 0)' },
    ])
  })

  test("a background agent's reported result fills its card", async () => {
    const launched = "Async agent launched successfully. agentId: abc (internal ID - do not mention to user.)"
    const report = [
      "<task-notification>",
      "<task-id>t1</task-id>",
      "<tool-use-id>call_bg</tool-use-id>",
      "<status>completed</status>",
      '<summary>Agent "Review" finished</summary>',
      "<result>The review found two bugs.</result>",
      "</task-notification>",
    ].join("\n")
    await write("bg-agent", [
      user("u1", null, "review it in the background", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "call_bg", name: "Agent", input: { description: "Review" } }], 1, {
        stop: "tool_use",
      }),
      user("u2", "a1", [{ type: "tool_result", tool_use_id: "call_bg", content: [text(launched)] }], 2),
      assistant("a2", "u2", [text("it is running")], 3),
      user("n1", "a2", report, 10),
      assistant("a3", "n1", [text("done")], 11),
    ])
    const tool = turns(await load("bg-agent"))[1].parts[0]
    expect(tool).toMatchObject({
      type: "tool",
      subagentResult: "The review found two bugs.",
      output: "The review found two bugs.",
    })
  })

  test("a background agent with no reported result says so instead of the launch note", async () => {
    await write("bg-pending", [
      user("u1", null, "review it in the background", 0),
      assistant("a1", "u1", [{ type: "tool_use", id: "call_bg", name: "Agent", input: { description: "Review" } }], 1, {
        stop: "tool_use",
      }),
      user(
        "u2",
        "a1",
        [
          {
            type: "tool_result",
            tool_use_id: "call_bg",
            content: [text("Async agent launched successfully. agentId: abc")],
          },
        ],
        2,
      ),
      assistant("a2", "u2", [text("it is running")], 3),
    ])
    const tool = turns(await load("bg-pending"))[1].parts[0] as { output?: string; subagentResult?: string }
    expect(tool.output).toBe("Started in the background; no result was recorded in this conversation.")
    expect(tool.subagentResult).toBeUndefined()
  })

  test("lists the folder from the end of the file when the start lacks it", async () => {
    const dir = path.join(root, "-late-cwd")
    await fs.mkdir(dir, { recursive: true })
    // Ten 30 KB records without a folder, so the folder appears only near the end of the file.
    const head = Array.from({ length: 10 }, (_, i) => ({
      type: "file-history-snapshot",
      n: i,
      blob: "x".repeat(30_000),
    }))
    const rest = [user("u1", null, "late question", 1, { cwd: "/work/late" }), assistant("a1", "u1", [text("a")], 2)]
    await fs.writeFile(path.join(dir, "late.jsonl"), [...head, ...rest].map((r) => JSON.stringify(r)).join("\n") + "\n")
    const info = (await ClaudeReader.create(root).list()).find((item) => item.id === "late")
    expect(info?.cwd).toBe("/work/late")
  })
})
