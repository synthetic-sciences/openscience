import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, ToolPart } from "@synsci/sdk/v2/client"
import {
  buildTraceRows,
  buildTraceSegments,
  burstLabel,
  editedChanges,
  editedLabel,
  exploredLabel,
  thoughtLabel,
} from "./trace-rows"

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
  test("edit groups include deleted files and sum completed changes without treating missing counts as zero", () => {
    const parts = [
      tool("patch", "apply_patch", {
        metadata: { files: [{ filePath: "/project/old.md", type: "delete", additions: 0, deletions: 6 }] },
      }),
      tool("edit", "edit", { metadata: { filediff: { file: "/project/paper.md", additions: 4, deletions: 1 } } }),
    ]
    const row = buildTraceRows(entries(parts))[0] as Extract<
      ReturnType<typeof buildTraceRows>[number],
      { kind: "edited" }
    >
    expect(editedLabel(row)).toBe("Edited old.md, paper.md")
    expect(editedChanges(row)).toEqual({ additions: 4, deletions: 7 })
    const legacy = buildTraceRows(
      entries([...parts, tool("old", "write", {}, { filePath: "/project/legacy.md" })]),
    )[0] as typeof row
    expect(editedChanges(legacy)).toBeUndefined()
  })
  test("folds consecutive provider summaries and private continuations without losing their records", () => {
    const fragments = [
      reasoning("r1", 0, 20_000),
      { ...reasoning("r2", 20_000, 20_200), text: "[REDACTED]" } as Part,
      reasoning("r3", 20_200, 40_200),
    ]
    const rows = buildTraceRows(entries([...fragments, tool("read", "read"), reasoning("r4", 45_000)]))
    expect(rows.map((row) => row.kind)).toEqual(["thought", "explored", "thought"])
    const thought = rows[0] as Extract<(typeof rows)[number], { kind: "thought" }>
    expect(thought.entries.map((entry) => entry.part.id)).toEqual(["r1", "r2", "r3"])
    expect(thought.seconds).toBe(40)
    expect(thoughtLabel(thought.seconds, false)).toBe("Thought 40s")
  })

  test("a phase the provider kept entirely private keeps its time and has nothing to open", () => {
    const rows = buildTraceRows(
      entries([
        tool("read", "read"),
        { ...reasoning("r1", 0, 75_000), text: "[REDACTED]" } as Part,
        tool("grep", "grep"),
        reasoning("r2", 80_000, 82_000),
      ]),
    )
    expect(rows.map((row) => row.kind)).toEqual(["explored", "thought", "explored", "thought"])
    const quiet = rows[1] as Extract<(typeof rows)[number], { kind: "thought" }>
    expect(quiet.readable).toBe(false)
    expect(thoughtLabel(quiet.seconds, false)).toBe("Thought 1m 15s")
    expect((rows[3] as Extract<(typeof rows)[number], { kind: "thought" }>).readable).toBe(true)
  })

  test("patch edit counts use actual file receipts and keep distinct same-name files", () => {
    const rows = buildTraceRows(
      entries([
        tool("patch", "apply_patch", {
          metadata: {
            files: [
              { filePath: "/project/paper/README.md", type: "update" },
              { filePath: "/project/code/README.md", type: "update" },
              { filePath: "/project/figure.py", type: "add" },
            ],
          },
        }),
      ]),
    )
    expect(editedLabel(rows[0] as Extract<(typeof rows)[number], { kind: "edited" }>)).toBe("Edited 3 files")
  })

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

describe("trace segments", () => {
  const private_ = (id: string, start: number, end?: number) =>
    ({ ...reasoning(id, start, end), text: "[REDACTED]" }) as Part

  test("prose stays in place and the work between two paragraphs folds into one labelled burst", () => {
    const rows = buildTraceRows(
      entries([
        text("x1", "Checking the stack first."),
        private_("r1", 10_000, 70_000),
        tool("t1", "read", { time: { start: 70_000, end: 71_000 } }, { filePath: "/p/study.json" }),
        tool("t2", "bash", { metadata: { exit: 0 }, time: { start: 71_000, end: 90_000 } }),
        tool("t3", "apply_patch", {
          time: { start: 90_000, end: 95_000 },
          metadata: { files: [{ filePath: "/p/train.py", type: "update", additions: 3, deletions: 1 }] },
        }),
        tool("t4", "bash", { status: "error", error: "exit 1", time: { start: 95_000, end: 96_000 } } as never),
        text("x2", "The stack is verified."),
        tool("t5", "task", { time: { start: 100_000, end: 100_500 } }, { description: "Build backend" }),
        text("x3", "Both workers are dispatched."),
      ]),
    )
    const segments = buildTraceSegments(rows)
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "burst", "text", "burst", "text"])
    const first = segments[1] as Extract<(typeof segments)[number], { kind: "burst" }>
    // The private thought adds no row but its minute is on the clock.
    expect(first.rows.map((row) => row.kind)).toEqual(["explored", "edited", "tool"])
    expect(first.calls).toBe(4)
    expect(first.failed).toBe(1)
    expect(first.start).toBe(10_000)
    expect(first.end).toBe(96_000)
    expect(burstLabel(first, 999_999)).toBe("Read 1 file, ran 2 commands, edited 1 file · 1 failed · 1m 26s")
    const second = segments[3] as Extract<(typeof segments)[number], { kind: "burst" }>
    expect(second.rows.map((row) => row.kind)).toEqual(["agent"])
    expect(burstLabel(second, 999_999)).toBe("Delegated 1 task · 0s")
  })

  test("a readable thought keeps its row; a burst of thought alone reads like the row would", () => {
    const rows = buildTraceRows(entries([reasoning("r1", 0, 63_000), text("x1", "Here is the plan.")]))
    const segments = buildTraceSegments(rows)
    const burst = segments[0] as Extract<(typeof segments)[number], { kind: "burst" }>
    expect(burst.rows.map((row) => row.kind)).toEqual(["thought"])
    expect(burstLabel(burst, 999_999)).toBe("Thought 1m 3s")
    const quiet = buildTraceSegments(buildTraceRows(entries([private_("r2", 0, 5_000), text("x2", "Done.")])))
    expect((quiet[0] as Extract<(typeof quiet)[number], { kind: "burst" }>).rows).toEqual([])
    expect(burstLabel(quiet[0] as never, 999_999)).toBe("Thought 5s")
  })

  test("a burst stays open-ended while any call in it still runs, and a live thought keeps its row", () => {
    const rows = buildTraceRows(
      entries([
        tool("t1", "read", { time: { start: 1_000, end: 2_000 } }),
        tool("t2", "bash", { status: "running", time: { start: 2_000 } } as never),
        private_("r1", 3_000),
      ]),
    )
    const segments = buildTraceSegments(rows, (row) => row.kind === "thought")
    const burst = segments[0] as Extract<(typeof segments)[number], { kind: "burst" }>
    expect(burst.end).toBeUndefined()
    expect(burst.rows.map((row) => row.kind)).toEqual(["explored", "tool", "thought"])
    expect(burstLabel(burst, 62_000)).toBe("Read 1 file, ran 1 command · 1m 1s")
  })
})
