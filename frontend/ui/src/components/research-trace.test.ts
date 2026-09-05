import { describe, expect, test } from "bun:test"
import {
  elapsedLabel,
  foldRuns,
  formatTaskDuration,
  stripTaskMetadata,
  summarizeTaskActivity,
  type ResearchTraceEntry,
  visibleResearchTrace,
} from "./research-trace"

const entry = (id: string, tool: string, title: string, status = "completed", message = "msg") =>
  ({
    message: { id: message, role: "assistant", time: { created: 1, completed: 2 } },
    part: {
      id,
      type: "tool",
      tool,
      state: { status, input: {}, title, output: "" },
    },
  }) as ResearchTraceEntry

/** The same call inside a message that has not completed yet. */
const working = (id: string, tool: string, title: string, status = "completed", message = "msg") => {
  const item = entry(id, tool, title, status, message)
  return { ...item, message: { ...item.message, time: { created: 1 } } } as ResearchTraceEntry
}

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

  test("groups only adjacent successful shell preflights and retains their original calls", () => {
    const first = entry("shell-1", "bash", "Check Python runtime")
    const second = entry("shell-2", "bash", "Inspect workspace status")
    if (first.part.type === "tool") first.part.state.input = { command: "python --version" }
    if (second.part.type === "tool") second.part.state.input = { command: "git status --short" }
    const trace = visibleResearchTrace([first, second, entry("patch", "apply_patch", "Update report")])

    expect(trace.map((item) => item.part.id)).toEqual(["shell-1", "patch"])
    expect(trace[0]?.group?.map((item) => item.part.id)).toEqual(["shell-1", "shell-2"])
  })

  test("never groups failed or substantive shell work", () => {
    const check = entry("shell-1", "bash", "Check and train model")
    if (check.part.type === "tool") check.part.state.input = { command: "pwd && python train.py" }
    const trace = visibleResearchTrace([
      check,
      entry("shell-2", "bash", "Check dependency", "error"),
      entry("shell-3", "bash", "Train full model"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["shell-1", "shell-2", "shell-3"])
    expect(trace.some((item) => item.group)).toBe(false)
  })

  test("keeps a nonzero preflight exit individually inspectable in compact mode", () => {
    const calls = [0, 1, 0].map((exit, index) => {
      const call = entry(`shell-${index}`, "bash", "Find runtime")
      if (call.part.type === "tool" && call.part.state.status === "completed") {
        call.part.state.input = { command: "which python" }
        call.part.state.metadata = { exit }
      }
      return call
    })
    const trace = visibleResearchTrace(calls, "compact")
    expect(trace.map((item) => item.part.id)).toEqual(calls.map((item) => item.part.id))
    expect(trace.some((item) => item.group || item.run)).toBe(false)
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

describe("folded tool runs", () => {
  test("folds consecutive completed calls of one tool behind a counted header that keeps every call", () => {
    const trace = visibleResearchTrace([
      entry("read-1", "read", "Read paper.tex"),
      entry("read-2", "read", "Read analysis.py"),
      entry("read-3", "read", "Read results.csv"),
      entry("grep", "grep", "Find citations"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["read-1", "grep"])
    expect(trace[0]?.run?.map((item) => item.part.id)).toEqual(["read-1", "read-2", "read-3"])
    expect(trace[1]?.run).toBeUndefined()
  })

  test("a live or failed call breaks the run and stays on its own line", () => {
    const trace = foldRuns([
      entry("read-1", "read", "Read paper.tex"),
      entry("read-2", "read", "Read analysis.py"),
      entry("read-3", "read", "Read results.csv", "running"),
      entry("read-4", "read", "Read missing.csv", "error"),
      entry("read-5", "read", "Read notes.md"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["read-1", "read-3", "read-4", "read-5"])
    expect(trace[0]?.run?.map((item) => item.part.id)).toEqual(["read-1", "read-2"])
    expect(trace.slice(1).some((item) => item.run)).toBe(false)
  })

  test("leaves delegation, kernels, questions, and preflight groups literal", () => {
    const first = entry("shell-1", "bash", "Check Python runtime")
    const second = entry("shell-2", "bash", "Inspect workspace status")
    if (first.part.type === "tool") first.part.state.input = { command: "python --version" }
    if (second.part.type === "tool") second.part.state.input = { command: "git status --short" }
    const trace = visibleResearchTrace([
      first,
      second,
      entry("task-1", "task", "Delegate literature review"),
      entry("task-2", "task", "Delegate replication"),
      entry("py-1", "python", "Fit model"),
      entry("py-2", "python", "Plot ROC"),
      entry("ask-1", "question", "Confirm scope"),
      entry("ask-2", "question", "Confirm budget"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["shell-1", "task-1", "task-2", "py-1", "py-2", "ask-1", "ask-2"])
    expect(trace[0]?.group?.map((item) => item.part.id)).toEqual(["shell-1", "shell-2"])
    expect(trace.some((item) => item.run)).toBe(false)
  })

  test("keeps the newest call of a working message literal until a later call starts", () => {
    // read-2 just completed: its receipt stays on its own row rather than vanishing into a header.
    const settled = foldRuns([
      working("read-1", "read", "Read paper.tex"),
      working("read-2", "read", "Read analysis.py"),
    ])
    expect(settled.map((item) => item.part.id)).toEqual(["read-1", "read-2"])
    expect(settled.some((item) => item.run)).toBe(false)

    // The next call starts: the earlier reads fold while the live call and the newest call stay literal.
    const next = foldRuns([
      working("read-1", "read", "Read paper.tex"),
      working("read-2", "read", "Read analysis.py"),
      working("read-3", "read", "Read results.csv", "running"),
    ])
    expect(next.map((item) => item.part.id)).toEqual(["read-1", "read-3"])
    expect(next[0]?.run?.map((item) => item.part.id)).toEqual(["read-1", "read-2"])

    // read-3 completes: the folded run neither grows nor unfolds, so nothing on screen moves.
    const done = foldRuns([
      working("read-1", "read", "Read paper.tex"),
      working("read-2", "read", "Read analysis.py"),
      working("read-3", "read", "Read results.csv"),
    ])
    expect(done.map((item) => item.part.id)).toEqual(["read-1", "read-3"])
    expect(done[0]?.run?.map((item) => item.part.id)).toEqual(["read-1", "read-2"])
    expect(done[1]?.run).toBeUndefined()

    // Prose after the newest call does not settle it; only the message completing does.
    const prose = foldRuns([
      working("read-1", "read", "Read paper.tex"),
      working("read-2", "read", "Read analysis.py"),
      working("read-3", "read", "Read results.csv"),
      {
        ...narrative("answer", "text", "Findings so far", "msg"),
        message: { id: "msg", time: { created: 1 } },
      } as ResearchTraceEntry,
    ])
    expect(prose.map((item) => item.part.id)).toEqual(["read-1", "read-3", "answer"])

    const complete = foldRuns([
      entry("read-1", "read", "Read paper.tex"),
      entry("read-2", "read", "Read analysis.py"),
      entry("read-3", "read", "Read results.csv"),
    ])
    expect(complete.map((item) => item.part.id)).toEqual(["read-1"])
    expect(complete[0]?.run).toHaveLength(3)
  })

  test("settles the newest call per message, so an earlier completed step folds fully", () => {
    const trace = foldRuns([
      entry("read-1", "read", "Read paper.tex", "completed", "step-1"),
      entry("read-2", "read", "Read analysis.py", "completed", "step-1"),
      working("read-3", "read", "Read results.csv", "completed", "step-2"),
    ])
    expect(trace.map((item) => item.part.id)).toEqual(["read-1", "read-3"])
    expect(trace[0]?.run?.map((item) => item.part.id)).toEqual(["read-1", "read-2"])
    expect(trace[1]?.run).toBeUndefined()
  })

  test("folds edits and shell work while keeping a single call unfolded", () => {
    const trace = foldRuns([
      entry("edit-1", "edit", "Update report"),
      entry("edit-2", "edit", "Update figure"),
      entry("shell-1", "bash", "Run tests"),
      entry("shell-2", "bash", "Run lint"),
      entry("write", "write", "Write summary"),
    ])

    expect(trace.map((item) => item.part.id)).toEqual(["edit-1", "shell-1", "write"])
    expect(trace[0]?.run).toHaveLength(2)
    expect(trace[1]?.run).toHaveLength(2)
    expect(trace[2]?.run).toBeUndefined()
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
