import type { AssistantMessage, Part, ToolPart } from "@synsci/sdk/v2/client"

export type ResearchTraceEntry = {
  message: AssistantMessage
  part: Part
  hidden?: boolean
}

export type ResearchTraceGroup = {
  kind: "group"
  id: string
  family: TraceFamily
  label: string
  detail: string
  entries: ResearchTraceEntry[]
}

export type ResearchTraceItem =
  | {
      kind: "part"
      entry: ResearchTraceEntry
    }
  | ResearchTraceGroup

export type TaskActivity = {
  id: string
  tool: string
  state: {
    status: string
    title?: string
  }
}

export type TaskActivityGroup = {
  family: TraceFamily
  label: string
  detail: string
  count: number
  failed: number
}

export type TraceFamily = "context" | "sources" | "commands" | "changes" | "images" | "skills" | "other"

const context = new Set(["read", "list", "glob", "grep", "codesearch"])
const sources = new Set(["webfetch", "websearch", "science_fetch", "science_search", "atlas"])
const commands = new Set(["bash", "python", "r", "notebook", "rkernel", "modal", "compute_job"])
const changes = new Set(["edit", "write", "multiedit", "apply_patch"])
const images = new Set(["generate_image"])
const skills = new Set(["skill", "learn"])

export function traceFamily(tool: string): TraceFamily {
  if (context.has(tool)) return "context"
  if (sources.has(tool)) return "sources"
  if (commands.has(tool)) return "commands"
  if (changes.has(tool)) return "changes"
  if (images.has(tool)) return "images"
  if (skills.has(tool)) return "skills"
  return "other"
}

export function traceLabel(family: TraceFamily, count: number) {
  if (family === "context")
    return `Reviewed ${count} ${count === 1 ? "file or code search" : "files and code searches"}`
  if (family === "sources") return `Checked ${count} external ${count === 1 ? "source" : "sources"}`
  if (family === "commands") return `Ran ${count} build or verification ${count === 1 ? "step" : "steps"}`
  if (family === "changes") return `Updated ${count} ${count === 1 ? "file" : "files"}`
  if (family === "images") return `Generated ${count} ${count === 1 ? "image" : "images"}`
  if (family === "skills") return `Loaded ${count} research ${count === 1 ? "skill" : "skills"}`
  return `Completed ${count} research ${count === 1 ? "operation" : "operations"}`
}

function toolTitle(part: ToolPart) {
  const state = part.state
  if ("title" in state && typeof state.title === "string" && state.title.trim()) return state.title.trim()
  const input = state.input ?? {}
  const value = input.filePath ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description
  if (typeof value === "string" && value.trim()) return value.trim()
  return part.tool
}

function compact(values: string[], limit = 3) {
  const unique = [...new Set(values)]
  const visible = unique.slice(0, limit)
  const hidden = unique.length - visible.length
  return [visible.join(" · "), hidden > 0 ? `+${hidden} more` : undefined].filter(Boolean).join(" · ")
}

function grouped(part: Part): part is ToolPart {
  if (part.type !== "tool") return false
  if (part.state.status !== "completed") return false
  if (part.tool === "task" || part.tool === "todowrite" || part.tool === "todoread" || part.tool === "planwrite") {
    return false
  }
  return traceFamily(part.tool) !== "other"
}

function narrative(part: Part) {
  return part.type === "reasoning" || part.type === "text"
}

function lifecycle(part: Part) {
  return part.type === "step-start" || part.type === "step-finish" || part.type === "snapshot" || part.type === "patch"
}

/**
 * Keep provider-visible reasoning and intermediate text byte-for-byte in their
 * chronological position. Only repeated completed tools are compacted; opening
 * a group always reveals the literal operations and surrounding reasoning.
 */
export function groupResearchTrace(entries: ResearchTraceEntry[]): ResearchTraceItem[] {
  const output: ResearchTraceItem[] = []
  const state = {
    phase: undefined as
      | {
          family: TraceFamily
          entries: ResearchTraceEntry[]
          tools: ResearchTraceEntry[]
        }
      | undefined,
    bridge: [] as ResearchTraceEntry[],
  }

  const parts = (items: ResearchTraceEntry[]) => {
    for (const entry of items) output.push({ kind: "part", entry })
  }

  const flush = () => {
    const phase = state.phase
    if (!phase) return
    if (phase.tools.length === 1) {
      parts(phase.entries)
      state.phase = undefined
      return
    }

    output.push({
      kind: "group",
      id: `trace-${phase.tools[0].part.id}-${phase.tools.at(-1)!.part.id}`,
      family: phase.family,
      label: traceLabel(phase.family, phase.tools.length),
      detail: compact(phase.tools.map((entry) => toolTitle(entry.part as ToolPart))),
      entries: phase.entries,
    })
    state.phase = undefined
  }

  for (const entry of entries) {
    if (lifecycle(entry.part)) continue

    if (entry.hidden) {
      if (state.phase) {
        state.phase.entries.push(...state.bridge)
        state.bridge = []
        flush()
      } else {
        parts(state.bridge)
        state.bridge = []
      }
      continue
    }

    if (narrative(entry.part)) {
      state.bridge.push(entry)
      continue
    }

    if (!grouped(entry.part)) {
      if (state.phase) {
        state.phase.entries.push(...state.bridge)
        state.bridge = []
        flush()
      } else {
        parts(state.bridge)
        state.bridge = []
      }
      output.push({ kind: "part", entry })
      continue
    }

    const family = traceFamily(entry.part.tool)
    if (!state.phase) {
      state.phase = { family, entries: [...state.bridge, entry], tools: [entry] }
      state.bridge = []
      continue
    }

    if (state.phase.family === family) {
      state.phase.entries.push(...state.bridge, entry)
      state.phase.tools.push(entry)
      state.bridge = []
      continue
    }

    flush()
    state.phase = { family, entries: [...state.bridge, entry], tools: [entry] }
    state.bridge = []
  }

  if (state.phase) {
    state.phase.entries.push(...state.bridge)
    state.bridge = []
    flush()
  } else {
    parts(state.bridge)
  }
  return output
}

export function summarizeTaskActivity(items: TaskActivity[]): TaskActivityGroup[] {
  const groups = new Map<TraceFamily, TaskActivityGroup & { titles: string[] }>()
  for (const item of items) {
    const family = traceFamily(item.tool)
    const previous = groups.get(family)
    const titles = item.state.title?.trim()
      ? [...(previous?.titles ?? []), item.state.title.trim()]
      : (previous?.titles ?? [])
    groups.set(family, {
      family,
      count: (previous?.count ?? 0) + 1,
      failed: (previous?.failed ?? 0) + (item.state.status === "error" ? 1 : 0),
      label: "",
      detail: "",
      titles,
    })
  }
  return [...groups.values()].map((group) => ({
    family: group.family,
    count: group.count,
    failed: group.failed,
    label: traceLabel(group.family, group.count),
    detail: compact(group.titles.length > 0 ? group.titles : [group.family]),
  }))
}

export function stripTaskMetadata(value?: string) {
  return (value ?? "").replace(/\s*<task_metadata>[\s\S]*?<\/task_metadata>\s*/g, "").trim()
}

export function formatTaskDuration(value?: number) {
  if (value === undefined) return undefined
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
  return `${Math.floor(value / 3_600_000)}h ${Math.round((value % 3_600_000) / 60_000)}m`
}
