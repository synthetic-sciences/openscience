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

describe("research trace grouping", () => {
  test("collapses consecutive file reads and searches into one meaningful activity", () => {
    const trace = groupResearchTrace([
      entry("read-1", "read", "Read paper.tex"),
      entry("grep-1", "grep", "Find citations"),
      entry("read-2", "read", "Read references.bib"),
    ])

    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({
      kind: "group",
      family: "context",
      label: "Reviewed 3 files and code searches",
    })
  })

  test("keeps delegation and a single operation as first-class events", () => {
    const trace = groupResearchTrace([
      entry("task", "task", "Audit citations"),
      entry("read", "read", "Read paper.tex"),
    ])

    expect(trace.map((item) => item.kind)).toEqual(["part", "part"])
  })

  test("groups one semantic phase across assistant messages and invisible step bookkeeping", () => {
    const trace = groupResearchTrace([
      lifecycle("start-a", "step-start", "msg-a"),
      narrative("reason-a", "reasoning", "I will inspect the manuscript first.", "msg-a"),
      entry("read-a", "read", "Read paper.tex", "completed", "msg-a"),
      lifecycle("finish-a", "step-finish", "msg-a"),
      lifecycle("start-b", "step-start", "msg-b"),
      narrative("reason-b", "reasoning", "The bibliography is the next relevant file.", "msg-b"),
      entry("read-b", "read", "Read references.bib", "completed", "msg-b"),
      lifecycle("finish-b", "step-finish", "msg-b"),
    ])

    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({
      kind: "group",
      family: "context",
      label: "Reviewed 2 files and code searches",
    })
    if (trace[0].kind !== "group") throw new Error("expected a grouped research phase")
    expect(trace[0].entries.map((item) => [item.message.id, item.part.id])).toEqual([
      ["msg-a", "reason-a"],
      ["msg-a", "read-a"],
      ["msg-b", "reason-b"],
      ["msg-b", "read-b"],
    ])
  })

  test("starts a new phase when the tool family changes without reordering the bridge reasoning", () => {
    const trace = groupResearchTrace([
      entry("read", "read", "Read package.json"),
      narrative("reason", "reasoning", "The source is clear; now I will verify it.", "msg"),
      entry("test-a", "bash", "Run focused tests"),
      narrative("progress", "text", "The focused checks passed.", "msg-next"),
      entry("test-b", "bash", "Run typecheck", "completed", "msg-next"),
    ])

    expect(trace.map((item) => item.kind)).toEqual(["part", "group"])
    expect(trace[0]).toMatchObject({ kind: "part", entry: { part: { id: "read" } } })
    if (trace[1].kind !== "group") throw new Error("expected a command phase")
    expect(trace[1]).toMatchObject({ family: "commands", label: "Ran 2 build or verification steps" })
    expect(trace[1].entries.map((item) => item.part.id)).toEqual(["reason", "test-a", "progress", "test-b"])
  })

  test("keeps provider-visible reasoning raw, chronological, and free of a synthetic summary label", () => {
    const first = "Inspecting the exact citation records — no paraphrase."
    const second = "Cross-check complete; the DOI matches."
    const trace = groupResearchTrace([
      narrative("reason-a", "reasoning", first, "msg-a"),
      entry("source-a", "webfetch", "Open publisher record", "completed", "msg-a"),
      narrative("reason-b", "reasoning", second, "msg-b"),
      entry("source-b", "websearch", "Find DOI record", "completed", "msg-b"),
    ])

    if (trace[0].kind !== "group") throw new Error("expected a source phase")
    expect(trace[0].entries.flatMap((item) => (item.part.type === "reasoning" ? [item.part.text] : []))).toEqual([
      first,
      second,
    ])
    expect(trace[0].label).toBe("Checked 2 external sources")
    expect(trace[0].label).not.toContain("Reasoning summary")
  })

  test("first-class delegation is a hard boundary between otherwise related operations", () => {
    const trace = groupResearchTrace([
      entry("read-a", "read", "Read methods.tex"),
      entry("read-b", "read", "Read appendix.tex"),
      entry("task", "task", "Verify citations"),
      entry("read-c", "read", "Read review.txt"),
      entry("read-d", "grep", "Find rejected citations"),
    ])

    expect(trace.map((item) => item.kind)).toEqual(["group", "part", "group"])
    expect(
      trace.flatMap((item) => (item.kind === "group" ? [item.entries.map((value) => value.part.id)] : [])),
    ).toEqual([
      ["read-a", "read-b"],
      ["read-c", "read-d"],
    ])
  })

  test("keeps promoted outputs as invisible phase boundaries instead of grouping across them", () => {
    const promoted = entry("python", "python", "Run statistical analysis")
    promoted.hidden = true
    const trace = groupResearchTrace([
      entry("read-a", "read", "Read metrics.json"),
      entry("read-b", "grep", "Find primary metric"),
      promoted,
      entry("read-c", "read", "Read generated table"),
      entry("read-d", "grep", "Check confidence interval"),
    ])

    expect(trace.map((item) => item.kind)).toEqual(["group", "group"])
    expect(trace.flatMap((item) => (item.kind === "group" ? item.entries.map((value) => value.part.id) : []))).toEqual([
      "read-a",
      "read-b",
      "read-c",
      "read-d",
    ])
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
