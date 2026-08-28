import { describe, expect, test } from "bun:test"
import {
  formatTaskDuration,
  stripTaskMetadata,
  summarizeTaskActivity,
  type ResearchTraceEntry,
  visibleResearchTrace,
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
  test("keeps substantive reasoning chronological and tools readable", () => {
    const trace = visibleResearchTrace([
      lifecycle("start", "step-start", "msg"),
      narrative("reason", "reasoning", "provider-visible reasoning bytes", "msg"),
      entry("read", "read", "Read paper.tex"),
      narrative("progress", "text", "intermediate assistant text", "msg"),
      entry("search", "websearch", "Find source"),
      lifecycle("finish", "step-finish", "msg"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["reason", "read", "progress", "search"])
    expect(trace[0]?.part.type === "reasoning" && trace[0].part.text).toBe("provider-visible reasoning bytes")
  })

  test("deduplicates a streaming text update by part ID without moving its chronological position", () => {
    const trace = visibleResearchTrace([
      narrative("reason-1", "reasoning", "First thought", "msg"),
      narrative("response", "text", "Draft response", "msg"),
      narrative("reason-2", "reasoning", "Refining the answer", "msg"),
      narrative("response", "text", "Final response", "msg"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["reason-1", "response", "reason-2"])
    expect(trace[1]?.part.type === "text" && trace[1].part.text).toBe("Final response")
  })

  test("does not hide reasoning between otherwise related tool families", () => {
    const trace = visibleResearchTrace([
      narrative("reason-1", "reasoning", "First thought", "msg-1"),
      entry("read", "read", "Read paper.tex", "completed", "msg-1"),
      lifecycle("finish", "step-finish", "msg-1"),
      lifecycle("start", "step-start", "msg-2"),
      narrative("reason-2", "reasoning", "Second thought", "msg-2"),
      entry("grep", "grep", "Find citations", "completed", "msg-2"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["reason-1", "read", "reason-2", "grep"])
  })

  test("keeps adjacent completed tools as literal stable rows", () => {
    const trace = visibleResearchTrace([
      entry("read", "read", "Read paper.tex"),
      entry("grep", "grep", "Find citations"),
      entry("list", "list", "List references"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["read", "grep", "list"])
  })

  test("collapses adjacent completed skill loads into one truthful disclosure", () => {
    const trace = visibleResearchTrace([
      {
        ...entry("skill-1", "skill", "Loaded skill: scientific-schematics"),
        part: {
          ...entry("skill-1", "skill", "Loaded skill: scientific-schematics").part,
          state: {
            status: "completed",
            input: { name: "scientific-schematics" },
            metadata: { name: "scientific-schematics" },
            output: "instructions",
          },
        },
      } as unknown as ResearchTraceEntry,
      {
        ...entry("skill-2", "skill", "Loaded skill: ml-paper-writing"),
        part: {
          ...entry("skill-2", "skill", "Loaded skill: ml-paper-writing").part,
          state: {
            status: "completed",
            input: { name: "ml-paper-writing" },
            metadata: { name: "ml-paper-writing" },
            output: "instructions",
          },
        },
      } as unknown as ResearchTraceEntry,
    ])

    expect(trace).toHaveLength(1)
    const aggregated = trace[0]?.part
    expect(aggregated?.type === "tool" && aggregated.state.status === "completed" && aggregated.state.metadata).toEqual(
      {
        names: ["scientific-schematics", "ml-paper-writing"],
      },
    )
  })

  test("does not group skill search results as skills that were used", () => {
    const searched = entry("skill-search", "skill", "Skill matches: figures")
    const trace = visibleResearchTrace([
      {
        ...searched,
        part: {
          ...searched.part,
          state: {
            status: "completed",
            input: { query: "figures" },
            metadata: { matches: ["scientific-schematics"] },
            output: "matches",
          },
        },
      } as unknown as ResearchTraceEntry,
      entry("read", "read", "Read paper.tex"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["skill-search", "read"])
  })

  test("collapses adjacent skill discovery calls without claiming the matches were loaded", () => {
    const searched = (id: string, query: string, matches: string[]) => {
      const item = entry(id, "skill", `Skill matches: ${query}`)
      return {
        ...item,
        part: {
          ...item.part,
          state: {
            status: "completed",
            input: { query },
            metadata: { matches },
            output: "matches",
          },
        },
      } as unknown as ResearchTraceEntry
    }
    const trace = visibleResearchTrace([
      searched("search-1", "writing figures", ["scientific-writing", "scientific-schematics"]),
      searched("search-2", "vector diagrams", ["scientific-schematics", "scientific-visualization"]),
      entry("read", "read", "Read report.md"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["search-1", "read"])
    const search = trace[0]?.part
    expect(search?.type === "tool" && search.state.status === "completed" && search.state.metadata).toEqual({
      matches: ["scientific-writing", "scientific-schematics", "scientific-visualization"],
    })
  })

  test("keeps repeated failed source attempts individually inspectable", () => {
    const trace = visibleResearchTrace([
      entry("fetch-1", "webfetch", "Download returned HTML", "error"),
      entry("fetch-2", "webfetch", "Download returned HTML", "error"),
      entry("fetch-3", "webfetch", "Endpoint returned 404", "error"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["fetch-1", "fetch-2", "fetch-3"])
  })

  test("keeps provider status-only reasoning chronological instead of leaving a tool-only gap", () => {
    const trace = visibleResearchTrace([
      narrative("status-1", "reasoning", "Planning source retrieval", "msg-1"),
      entry("search", "websearch", "Find assay data", "completed", "msg-1"),
      narrative("status-2", "reasoning", "Inspecting assay metadata", "msg-2"),
      entry("fetch", "webfetch", "Fetch assay data", "completed", "msg-2"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["status-1", "search", "status-2", "fetch"])
  })

  test("omits deliberately hidden tools from the inline activity list", () => {
    const hidden = entry("artifact", "artifact", "Save result")
    hidden.hidden = true
    const trace = visibleResearchTrace([entry("read", "read", "Read data"), hidden])
    expect(trace.map((item) => item.part.id)).toEqual(["read"])
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
