import { describe, expect, test } from "bun:test"
import {
  elapsedLabel,
  formatTaskDuration,
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
    ["former placeholder", "Considering next steps"],
    ["whitespace", "  Original whitespace\n\nand headings remain unchanged.  "],
    ["long", "Full provider prose. ".repeat(2000)],
  ])("retains nonempty %s reasoning unchanged", (_label, text) => {
    const item = narrative("reason", "reasoning", text)
    expect(visibleResearchTrace([item])).toEqual([item])
    expect(visibleResearchTrace([item])[0]).toBe(item)
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

  test("omits provider-hidden placeholders rather than inventing a reasoning row", () => {
    const unavailable = narrative("reason", "reasoning", "[REDACTED]")
    expect(visibleResearchTrace([unavailable])).toEqual([])
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
      { family: "skills", count: 1, failed: 0, label: "Using 1 skill", detail: "scientific-schematics" },
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
