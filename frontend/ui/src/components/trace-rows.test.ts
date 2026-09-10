import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, ToolPart } from "@synsci/sdk/v2/client"
import { buildTraceRows, editedLabel, exploredLabel, thoughtLabel } from "./trace-rows"

const message = {
  id: "msg_a",
  sessionID: "ses_a",
  role: "assistant",
  time: { created: 1 },
} as unknown as AssistantMessage

function tool(id: string, name: string, extra: Partial<ToolPart["state"]> = {}, input: Record<string, unknown> = {}) {
  return {
    id,
    sessionID: "ses_a",
    messageID: "msg_a",
    type: "tool",
    tool: name,
    callID: `call_${id}`,
    state: { status: "completed", input, output: "", metadata: {}, time: { start: 1, end: 2 }, ...extra },
  } as unknown as ToolPart
}

function text(id: string, value: string): Part {
  return { id, sessionID: "ses_a", messageID: "msg_a", type: "text", text: value } as Part
}

function reasoning(id: string, start: number, end?: number): Part {
  return { id, sessionID: "ses_a", messageID: "msg_a", type: "reasoning", text: "…", time: { start, end } } as Part
}

const entries = (parts: Part[]) => parts.map((part) => ({ message, part }))

describe("trace rows", () => {
  test("folds a burst of quiet exploration into one row and counts what it did", () => {
    const rows = buildTraceRows(
      entries([
        reasoning("r1", 0, 57_000),
        tool("t1", "read", {}, { filePath: "/a/paper.tex" }),
        tool("t2", "grep"),
        tool("t3", "bash", { metadata: { exit: 0 } }),
        tool("t4", "webfetch"),
        text("x1", "Here is what I found."),
      ]),
    )
    expect(rows.map((row) => row.kind)).toEqual(["thought", "explored", "text"])
    const burst = rows[1] as Extract<(typeof rows)[number], { kind: "explored" }>
    expect(burst.entries).toHaveLength(4)
    expect(exploredLabel(burst)).toBe("Explored 2 files, 1 source, ran 1 command")
    expect(thoughtLabel(57, false)).toBe("Thought 57s")
    expect(thoughtLabel(0, false)).toBe("Thought briefly")
    expect(thoughtLabel(125, false)).toBe("Thought 2m 5s")
    expect(thoughtLabel(undefined, true)).toBe("Thinking")
    expect((rows[2] as Extract<(typeof rows)[number], { kind: "text" }>).narration).toBe(false)
  })

  test("a running call, a failure, an agent and a receipt each keep their own row", () => {
    const rows = buildTraceRows(
      entries([
        tool("t1", "read"),
        tool("t2", "bash", { status: "running" } as never),
        tool("t3", "read"),
        tool("t4", "bash", { metadata: { exit: 1 } }),
        tool("t5", "task", {}, { description: "Map routing", subagent_type: "explore" }),
        tool("t6", "skill", { title: "Loaded skill: matplotlib", metadata: { name: "matplotlib", dir: "/skills/m" } }),
        tool("t7", "read"),
      ]),
    )
    expect(rows.map((row) => row.kind)).toEqual(["explored", "tool", "explored", "tool", "agent", "tool", "explored"])
    expect(exploredLabel(rows[0] as never)).toBe("Read 1 file")
  })

  test("labels follow what the burst actually contained", () => {
    const commands = buildTraceRows(entries([tool("a", "bash"), tool("b", "python"), tool("c", "bash")]))
    expect(exploredLabel(commands[0] as never)).toBe("Ran 3 commands")
    const sources = buildTraceRows(entries([tool("a", "webfetch"), tool("b", "research_search")]))
    expect(exploredLabel(sources[0] as never)).toBe("Searched 2 sources")
    const edits = buildTraceRows(
      entries([
        tool("a", "edit", {}, { filePath: "/p/notes.md" }),
        tool("b", "write", {}, { filePath: "/p/plot.py" }),
        tool("c", "edit", {}, { filePath: "/p/notes.md" }),
      ]),
    )
    expect(edits).toHaveLength(1)
    expect(editedLabel(edits[0] as never)).toBe("Edited notes.md, plot.py")
  })

  test("narration is text before later work; the last text is always the answer", () => {
    const rows = buildTraceRows(
      entries([
        text("x1", "Let me look."),
        tool("t1", "read"),
        text("x2", "Done: the answer."),
        tool("t2", "write", {}, { filePath: "/p/out.md" }),
      ]),
    )
    const texts = rows.filter((row) => row.kind === "text") as Extract<(typeof rows)[number], { kind: "text" }>[]
    expect(texts.map((row) => row.narration)).toEqual([true, false])
  })
})
