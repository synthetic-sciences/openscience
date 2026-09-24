import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, ToolPart } from "@synsci/sdk/v2/client"
import {
  buildTraceRows,
  collapsedTraceRows,
  COMPACTED_NOTE,
  editedChanges,
  editedLabel,
  exploredLabel,
  noteLabel,
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

describe("collapsed trace rows", () => {
  test("tool availability is internal detail in live, stopped, and completed turns", () => {
    const parts: Part[] = [
      {
        ...text("added", "Tools added: edit, write.\nUse only the currently advertised tool definitions."),
        synthetic: true,
      } as Part,
      { ...text("removed", "Tools removed: bash."), synthetic: true } as Part,
      text("answer", "The file is ready."),
    ]
    const rows = buildTraceRows(entries(parts))
    expect(rows.filter((row) => row.kind === "note" && row.details)).toHaveLength(2)
    for (const state of [
      { working: true, settled: false },
      { working: false, settled: false },
      { working: false, settled: true },
    ]) {
      expect(collapsedTraceRows(rows, state).map((row) => row.kind)).toEqual(["text"])
    }
    // A person discussing the same words is still ordinary conversation.
    expect(buildTraceRows(entries([text("typed", "Tools added: edit, write.")]))[0].kind).toBe("text")
  })

  const earlier = { ...message, id: "msg_earlier" } as AssistantMessage
  const final = { ...message, id: "msg_final" } as AssistantMessage
  const failed = (id: string, owner: AssistantMessage) => ({
    message: owner,
    part: { ...tool(id, "bash", { status: "error", error: "exit 1" } as never), messageID: owner.id },
  })
  const saved = { message: final, part: tool("save", "artifact", { metadata: { artifact: { id: "art_1" } } }) }
  const rows = () =>
    buildTraceRows([
      failed("f1", earlier),
      { message: earlier, part: text("n", "Retrying with the other compiler.") },
      failed("f2", final),
      saved,
      { message: final, part: text("a", "Done.") },
    ])
  const kinds = (visible: ReturnType<typeof collapsedTraceRows>) =>
    visible.map((row) => ("entry" in row ? row.entry.part.id : row.kind))

  test("while the turn works, failures fold: they are the agent's to deal with", () => {
    expect(kinds(collapsedTraceRows(rows(), { working: true, settled: false, final: final.id }))).toEqual(["save", "a"])
  })

  test("once the turn has answered, recovered failures stay folded", () => {
    expect(kinds(collapsedTraceRows(rows(), { working: false, settled: true, final: final.id }))).toEqual(["save", "a"])
  })

  test("a turn that stopped without an answer shows the failures of its final step only", () => {
    expect(kinds(collapsedTraceRows(rows(), { working: false, settled: false, final: final.id }))).toEqual([
      "f2",
      "save",
      "a",
    ])
  })

  test("a pending request stays visible in every state", () => {
    const pending = { message: final, part: tool("ask", "question", { status: "running" } as never) }
    const withRequest = buildTraceRows([failed("f1", earlier), pending])
    for (const state of [
      { working: true, settled: false },
      { working: false, settled: true },
      { working: false, settled: false },
    ]) {
      expect(
        kinds(collapsedTraceRows(withRequest, { ...state, final: final.id, pendingRequestCallID: "call_ask" })),
      ).toContain("ask")
    }
  })
})

describe("trace rows", () => {
  test("a mid-turn compaction is one grey note between the work before and after it", () => {
    const marker = { id: "prt_c", sessionID: "ses_a", messageID: "msg_c", type: "compaction", auto: true } as Part
    const rows = buildTraceRows(entries([tool("read", "read"), marker, tool("bash", "bash"), text("t", "Done.")]))
    expect(rows.map((row) => row.kind)).toEqual(["explored", "note", "explored", "text"])
    const note = rows[1] as Extract<ReturnType<typeof buildTraceRows>[number], { kind: "note" }>
    expect(note.text).toBe(COMPACTED_NOTE)
    expect(noteLabel(note.text)).toBe("Context compacted.")
    // Once the fold's sizes are recorded, the row says how much it shrank; the
    // runtime's own "continue from the handoff" instruction is not a row.
    const sized = { ...(marker as object), before: 92_400, after: 6_120 } as Part
    const continuation = {
      id: "prt_k",
      sessionID: "ses_a",
      messageID: "msg_k",
      type: "text",
      synthetic: true,
      text: "Continue from the 'Next Move' in the handoff above. Trust the handoff. If the Objective is already complete, give the user your result and stop.",
    } as Part
    const sizedRows = buildTraceRows(entries([tool("read", "read"), sized, continuation, tool("bash", "bash")]))
    expect(sizedRows.map((row) => row.kind)).toEqual(["explored", "note", "explored"])
    const sizedNote = sizedRows[1] as Extract<ReturnType<typeof buildTraceRows>[number], { kind: "note" }>
    expect(noteLabel(sizedNote.text)).toBe("Context compacted · 92K → 6.1K tokens.")
  })
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

  test("an answer a finished response ended with stays the answer when the harness continues the turn", () => {
    const first = { ...message, id: "msg_first", finish: "stop" } as AssistantMessage
    const second = { ...message, id: "msg_second", finish: "stop" } as AssistantMessage
    const rows = buildTraceRows([
      { message: first, part: text("a1", "Let me look.") },
      { message: first, part: tool("t1", "read") },
      { message: first, part: text("a2", "Created the two tables: …") },
      // The deliverables check wrote its note into the turn; the agent went on.
      {
        message: second,
        part: {
          ...text(
            "n1",
            "Before finishing, the deliverables checklist was checked mechanically. These outputs are not ready: results/x.csv.",
          ),
          synthetic: true,
        } as Part,
      },
      { message: second, part: tool("t2", "bash") },
      { message: second, part: text("a3", "Both files exist now.") },
    ])
    const kinds = rows.map((row) => row.kind)
    expect(kinds).toEqual(["text", "explored", "text", "note", "explored", "text"])
    const texts = rows.filter((row) => row.kind === "text") as Extract<(typeof rows)[number], { kind: "text" }>[]
    // "Let me look." is narration; the completed answer and the final answer both stay.
    expect(texts.map((row) => row.narration)).toEqual([true, false, false])
    const note = rows[3] as Extract<(typeof rows)[number], { kind: "note" }>
    expect(note.text).toStartWith("Before finishing, the deliverables checklist")
    // Text a response that went on to call tools ended with is still narration.
    const working = { ...message, id: "msg_work", finish: "tool-calls" } as AssistantMessage
    const plain = buildTraceRows([
      { message: working, part: text("w1", "Now the plot.") },
      { message: working, part: tool("t3", "bash") },
      { message: second, part: text("w2", "Done.") },
    ])
    const plainTexts = plain.filter((row) => row.kind === "text") as Extract<(typeof plain)[number], { kind: "text" }>[]
    expect(plainTexts.map((row) => row.narration)).toEqual([true, false])
  })
})
