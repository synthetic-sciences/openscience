import { describe, expect, test } from "bun:test"
import {
  collapsibleTracePart,
  elapsedLabel,
  formatTaskDuration,
  parseTaskHandoff,
  pluralize,
  stripTaskMetadata,
  summarizeTaskActivity,
  type ResearchTraceEntry,
  visibleResearchTrace,
} from "./research-trace"

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const assistant = (id: string): ResearchTraceEntry["message"] => ({
  id,
  sessionID: "session",
  role: "assistant",
  time: { created: 1, completed: 2 },
  parentID: "user",
  modelID: "model",
  providerID: "provider",
  mode: "research",
  agent: "research",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens,
})

const entry = (
  id: string,
  tool: string,
  title: string,
  status: "completed" | "error" | "running" = "completed",
  message = "msg",
): ResearchTraceEntry => {
  const state = { input: { value: id }, time: { start: 1, end: 2 } }
  return {
    message: assistant(message),
    part: {
      id,
      sessionID: "session",
      messageID: message,
      type: "tool",
      tool,
      callID: id,
      state:
        status === "completed"
          ? { ...state, status, title, output: `Original output for ${id}`, metadata: {} }
          : status === "error"
            ? { ...state, status, error: title }
            : { ...state, status, title },
    },
  }
}

const narrative = (id: string, type: "reasoning" | "text", text: string, message = "msg"): ResearchTraceEntry => ({
  message: assistant(message),
  part: { id, type, text, sessionID: "session", messageID: message, time: { start: 1 } },
})

const lifecycle = (id: string, type: "step-start" | "step-finish", message = "msg"): ResearchTraceEntry => {
  const part = { id, sessionID: "session", messageID: message }
  return {
    message: assistant(message),
    part: type === "step-finish" ? { ...part, type, reason: "tool-calls", cost: 0, tokens } : { ...part, type },
  }
}

describe("literal research trace", () => {
  test("collapses routine activity but retains answers, requests, failures, and scientific results", () => {
    expect(collapsibleTracePart(narrative("reason", "reasoning", "Full reasoning").part)).toBe(true)
    expect(collapsibleTracePart(narrative("answer", "text", "Final response").part)).toBe(false)
    expect(collapsibleTracePart(entry("read", "read", "Read source").part)).toBe(true)
    expect(collapsibleTracePart(entry("pending", "question", "Approval", "running").part, "pending")).toBe(false)
    expect(collapsibleTracePart(entry("error", "read", "Missing file", "error").part)).toBe(false)
    const command = entry("command", "bash", "Run calculation").part
    if (command.type !== "tool" || command.state.status !== "completed") throw new Error("Invalid fixture")
    command.state.metadata = { exit: 2 }
    expect(collapsibleTracePart(command)).toBe(false)
    command.state.metadata = { exit: 0 }
    expect(collapsibleTracePart(command)).toBe(true)
    command.state.metadata = { artifact: { kind: "sequence", data: { sequence: "ACGT" } } }
    expect(collapsibleTracePart(command)).toBe(false)
  })

  test("keeps only tasks with a pending request in their bound child session outside collapse", () => {
    const task = entry("task", "task", "Review protocol", "running").part
    if (task.type !== "tool" || task.state.status !== "running") throw new Error("Invalid fixture")
    task.state.metadata = { sessionId: "child" }
    expect(collapsibleTracePart(task)).toBe(true)
    expect(collapsibleTracePart(task, undefined, (id) => id === "unrelated")).toBe(true)
    expect(collapsibleTracePart(task, undefined, (id) => id === "child")).toBe(false)
    task.state.metadata = { sessionId: 12 }
    expect(collapsibleTracePart(task, undefined, () => true)).toBe(true)
    task.state.metadata = {}
    expect(collapsibleTracePart(task, undefined, () => true)).toBe(true)
  })

  test("does not bury an explicitly failed kernel behind a completed tool transport", () => {
    const kernel = entry("kernel", "python", "Evaluate control").part
    if (kernel.type !== "tool" || kernel.state.status !== "completed") throw new Error("Invalid fixture")
    kernel.state.metadata = { ok: false }
    expect(collapsibleTracePart(kernel)).toBe(false)
    kernel.state.metadata = { ok: true }
    expect(collapsibleTracePart(kernel)).toBe(true)
    kernel.state.metadata = { ok: "false" }
    expect(collapsibleTracePart(kernel)).toBe(true)
  })

  test.each(["error", "timed_out", "partial"])("keeps a completed delegated %s outcome visible", (outcome) => {
    const task = entry("task", "task", "Review protocol").part
    if (task.type !== "tool" || task.state.status !== "completed") throw new Error("Invalid fixture")
    task.state.metadata = { outcome }
    expect(collapsibleTracePart(task)).toBe(false)
    task.state.metadata = { outcome: "completed" }
    expect(collapsibleTracePart(task)).toBe(true)
    task.state.metadata = { outcome: "unknown" }
    expect(collapsibleTracePart(task)).toBe(true)
  })

  test("preserves prose and tool calls in their recorded order across assistant steps", () => {
    const first = narrative("reason-1", "reasoning", "First provider explanation", "msg-1")
    const read = entry("read", "read", "Read paper.tex", "completed", "msg-1")
    const text = narrative("progress", "text", "Intermediate response", "msg-1")
    const second = narrative("reason-2", "reasoning", "Second provider explanation", "msg-2")
    const search = entry("search", "websearch", "Find source", "completed", "msg-2")
    expect(
      visibleResearchTrace([
        lifecycle("start", "step-start", "msg-1"),
        first,
        read,
        text,
        lifecycle("finish", "step-finish", "msg-1"),
        second,
        search,
      ]),
    ).toEqual([first, read, text, second, search])
  })

  test.each([
    ["short", "Okay"],
    ["status-shaped", "Planning source retrieval"],
    ["headed", "**Thinking**\n\nI should compare both controls before changing the design."],
    ["whitespace", "  Original whitespace\n\nand headings remain unchanged.  "],
    ["long", "Full provider prose. ".repeat(2000)],
  ])("retains nonempty %s reasoning unchanged", (_label, text) => {
    const item = narrative("reason", "reasoning", text)
    expect(visibleResearchTrace([item])).toEqual([item])
    expect(visibleResearchTrace([item])[0]).toBe(item)
  })

  test("omits standalone generic status labels without deleting their saved source", () => {
    const item = narrative("status", "reasoning", "Considering next steps")
    expect(visibleResearchTrace([item])).toEqual([])
    expect(item.part).toMatchObject({ text: "Considering next steps" })
  })

  test.each(["read", "bash", "websearch", "edit", "skill"])(
    "never aggregates repeated %s calls or replaces their input/output",
    (tool) => {
      const calls = [
        entry("one", tool, "First call"),
        entry("two", tool, "Second call"),
        entry("three", tool, "Third call"),
      ]
      expect(visibleResearchTrace(calls)).toEqual(calls)
      for (const [index, item] of visibleResearchTrace(calls).entries()) expect(item).toBe(calls[index])
    },
  )

  test("keeps skill discovery and loaded skills as separate original receipts", () => {
    const searched = entry("search", "skill", "Skill matches: figures")
    const loaded = entry("load", "skill", "Loaded skill: figures")
    if (searched.part.type === "tool") searched.part.state.input = { query: "figures" }
    if (loaded.part.type === "tool") loaded.part.state.input = { name: "figures" }
    const calls = [searched, loaded]
    expect(visibleResearchTrace(calls)).toEqual(calls)
    expect(collapsibleTracePart(loaded.part)).toBe(false)
    expect(collapsibleTracePart(searched.part)).toBe(true)
    expect(collapsibleTracePart(entry("loading", "skill", "Loaded skill: figures", "running").part)).toBe(true)
    expect(collapsibleTracePart(entry("failed", "skill", "Permission denied", "error").part)).toBe(false)
  })

  test("running, failed, and completed tools all keep individual chronological rows", () => {
    const calls = [
      entry("one", "bash", "First", "completed"),
      entry("two", "bash", "Failed", "error"),
      entry("three", "bash", "Running", "running"),
    ]
    expect(visibleResearchTrace(calls)).toEqual(calls)
    const complete = entry("three", "bash", "Completed", "completed")
    expect(visibleResearchTrace([...calls, complete])).toEqual([calls[0], calls[1], complete])
  })

  test("replaces a streaming part by stable ID without moving it or rewriting the latest payload", () => {
    const first = narrative("reason-1", "reasoning", "First thought")
    const partial = narrative("response", "text", "Draft response")
    const second = narrative("reason-2", "reasoning", "Refining the answer")
    const final = narrative("response", "text", "Full final response")
    expect(visibleResearchTrace([first, partial, second, final])).toEqual([first, final, second])
  })

  test("retains private-only steps for an honest availability notice", () => {
    const unavailable = narrative("reason", "reasoning", "[REDACTED]")
    expect(visibleResearchTrace([unavailable])).toEqual([unavailable])
    const mixed = narrative("mixed", "reasoning", "Readable prose. [REDACTED]")
    expect(visibleResearchTrace([mixed])).toEqual([mixed])
    expect(visibleResearchTrace([mixed])[0]).toBe(mixed)
  })

  test("omits only empty reasoning, lifecycle markers, and explicitly separate presentation", () => {
    const hidden = { ...entry("artifact", "artifact", "Gallery result"), hidden: true }
    const visible = narrative("text", "text", "Visible answer")
    expect(
      visibleResearchTrace([
        lifecycle("start", "step-start"),
        narrative("empty", "reasoning", " \n"),
        hidden,
        visible,
        lifecycle("finish", "step-finish"),
      ]),
    ).toEqual([visible])
  })
})

describe("elapsedLabel", () => {
  test("counts whole seconds and never goes negative", () => {
    expect(elapsedLabel(0)).toBe("0s")
    expect(elapsedLabel(999)).toBe("0s")
    expect(elapsedLabel(12_400)).toBe("12s")
    expect(elapsedLabel(65_000)).toBe("1m 5s")
    expect(elapsedLabel(-3_000)).toBe("0s")
  })
})

describe("delegation summaries", () => {
  test("groups raw child operations and retains failures", () => {
    const groups = summarizeTaskActivity([
      { id: "1", tool: "webfetch", state: { status: "completed", title: "Open paper" } },
      { id: "2", tool: "websearch", state: { status: "error", title: "Find DOI" } },
      { id: "3", tool: "read", state: { status: "completed", title: "Read bibliography" } },
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ family: "sources", count: 2, failed: 1 })
    expect(groups[1]).toMatchObject({ family: "context", count: 1, failed: 0 })
  })

  test("counts only loaded skills as used", () => {
    const groups = summarizeTaskActivity([
      { id: "1", tool: "skill", state: { status: "completed", title: "Loaded skill: scientific-schematics" } },
      { id: "2", tool: "skill", state: { status: "completed", title: "Skill matches: figures" } },
    ])

    expect(groups).toEqual([
      { family: "skills", count: 1, failed: 0, label: "Loaded 1 skill", detail: "scientific-schematics" },
    ])
  })

  test("labels change calls as operations when child summaries contain no file receipts", () => {
    const groups = summarizeTaskActivity([
      { id: "1", tool: "apply_patch", state: { status: "completed", title: "Update two files" } },
      { id: "2", tool: "apply_patch", state: { status: "completed", title: "Update two more files" } },
    ])

    expect(groups).toEqual([
      {
        family: "changes",
        count: 2,
        failed: 0,
        label: "Edited 2 files",
        detail: "Update two files · Update two more files",
      },
    ])
  })

  test("removes the internal task metadata envelope from user-visible findings", () => {
    expect(
      stripTaskMetadata('Verified three citations.\n\n<task_metadata>{"session_id":"ses_child"}</task_metadata>'),
    ).toBe("Verified three citations.")
  })

  test("formats compact child durations", () => {
    expect(formatTaskDuration(800)).toBe("800ms")
    expect(formatTaskDuration(7_800)).toBe("7.8s")
    expect(formatTaskDuration(125_000)).toBe("2m 5s")
  })
})

describe("parseTaskHandoff", () => {
  test("separates the lead-facing preamble and evidence from the worker's findings", () => {
    const output = [
      "Task session ses_abc123: partial (max_steps). Reuse this sessionId to continue the same worker.",
      "[Child reached its bounded step limit; partial result follows.]",
      "## Findings",
      "",
      "Two assays disagree on the IC50.",
      "",
      "Saved outputs (immutable versions; use artifact read_file with these exact IDs):",
      '- "assays.csv": artifact_id=art_1, version_id=ver_1, bytes=120, sha256=abc',
      '- "note \\"quoted\\".md": artifact_id=art_2, version_id=ver_2, bytes=12, sha256=def',
      "Execution receipts: 3 shell calls, 2 with outer exit 0, 1 failed. Full receipts remain in the child trace.",
      "<task_metadata>",
      "sessionId: ses_abc123",
      "</task_metadata>",
    ].join("\n")
    expect(parseTaskHandoff(output)).toEqual({
      notes: ["Child reached its bounded step limit; partial result follows."],
      text: "## Findings\n\nTwo assays disagree on the IC50.",
      outputs: [
        { filename: "assays.csv", artifactID: "art_1" },
        { filename: 'note "quoted".md', artifactID: "art_2" },
      ],
      headed: true,
    })
  })

  test("keeps plain findings untouched and reports that they need a label", () => {
    expect(parseTaskHandoff("The comparison is ready; one source could not be retrieved.")).toEqual({
      notes: [],
      text: "The comparison is ready; one source could not be retrieved.",
      outputs: [],
      headed: false,
    })
    expect(parseTaskHandoff(undefined).text).toBe("")
  })

  test("keeps malformed output filenames readable instead of crashing the transcript", () => {
    const line = String.raw`- "report\q.csv": artifact_id=art_1, version_id=ver_1`
    const result = parseTaskHandoff(
      `Saved outputs (immutable versions; use artifact read_file with these exact IDs):\n${line}`,
    )
    expect(result.outputs).toEqual([])
    expect(result.text).toBe(line)
  })

  test("pluralizes operation counts", () => {
    expect(pluralize(1, "op")).toBe("1 op")
    expect(pluralize(3, "op")).toBe("3 ops")
    expect(pluralize(2, "source", "sources")).toBe("2 sources")
  })
})
