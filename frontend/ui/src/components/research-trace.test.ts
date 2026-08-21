import { describe, expect, test } from "bun:test"
import {
  formatTaskDuration,
  groupResearchTrace,
  stripTaskMetadata,
  summarizeTaskActivity,
  type ResearchTraceEntry,
} from "./research-trace"

const entry = (id: string, tool: string, title: string, status = "completed") =>
  ({
    message: { id: "msg", role: "assistant" },
    part: {
      id,
      type: "tool",
      tool,
      state: { status, input: {}, title, output: "" },
    },
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
