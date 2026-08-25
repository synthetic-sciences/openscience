import { describe, expect, test } from "bun:test"
import {
  formatTaskDuration,
  groupResearchTrace,
  stripTaskMetadata,
  summarizeTaskActivity,
  type ResearchTraceEntry,
} from "./research-trace"

const entry = (id: string, tool: string, title: string, status = "completed", message = "msg") =>
  ({
    message: { id: message, role: "assistant" },
    part: {
      id,
      type: "tool",
      tool,
      state: { status, input: {}, title, output: "" },
    },
  }) as ResearchTraceEntry

const narrative = (id: string, type: "reasoning" | "text", text: string, message: string) =>
  ({
    message: { id: message, role: "assistant" },
    part: { id, type, text },
  }) as ResearchTraceEntry

const lifecycle = (id: string, type: "step-start" | "step-finish", message: string) =>
  ({
    message: { id: message, role: "assistant" },
    part: type === "step-finish" ? { id, type, reason: "tool-calls", cost: 0, tokens: {} } : { id, type },
  }) as ResearchTraceEntry

describe("research trace presentation", () => {
  test("keeps provider-visible reasoning and tool operations chronological", () => {
    const trace = groupResearchTrace([
      lifecycle("start", "step-start", "msg"),
      narrative("reason", "reasoning", "provider-visible reasoning bytes", "msg"),
      entry("read", "read", "Read paper.tex"),
      narrative("progress", "text", "intermediate assistant text", "msg"),
      entry("search", "websearch", "Find source"),
      lifecycle("finish", "step-finish", "msg"),
    ])

    expect(trace.map((item) => item.kind)).toEqual(["part", "part", "part", "part"])
    expect(trace.map((item) => (item.kind === "part" ? item.entry.part.id : "group"))).toEqual([
      "reason",
      "read",
      "progress",
      "search",
    ])
    expect(trace[0]?.kind === "part" && trace[0].entry.part.type === "reasoning" && trace[0].entry.part.text).toBe(
      "provider-visible reasoning bytes",
    )
  })

  test("compacts repeated tool families without dropping interleaved reasoning", () => {
    const trace = groupResearchTrace([
      narrative("reason-1", "reasoning", "First thought", "msg-1"),
      entry("read", "read", "Read paper.tex", "completed", "msg-1"),
      lifecycle("finish", "step-finish", "msg-1"),
      lifecycle("start", "step-start", "msg-2"),
      narrative("reason-2", "reasoning", "Second thought", "msg-2"),
      entry("grep", "grep", "Find citations", "completed", "msg-2"),
    ])

    expect(trace).toHaveLength(1)
    expect(trace[0]?.kind).toBe("group")
    if (trace[0]?.kind !== "group") throw new Error("expected grouped context phase")
    expect(trace[0].entries.map((item) => item.part.id)).toEqual(["reason-1", "read", "reason-2", "grep"])
    expect(trace[0].label).toBe("Reviewed 2 files and code searches")
  })

  test("omits hidden promoted tools from the inline activity list", () => {
    const promoted = entry("python", "python", "Run analysis")
    promoted.hidden = true
    const trace = groupResearchTrace([entry("read", "read", "Read data"), promoted])
    expect(trace.map((item) => (item.kind === "part" ? item.entry.part.id : "group"))).toEqual(["read"])
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
