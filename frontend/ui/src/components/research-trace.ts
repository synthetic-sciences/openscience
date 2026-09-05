import type { AssistantMessage, Part } from "@synsci/sdk/v2/client"
import { stripRedactedReasoning } from "./tool-display"

export type ResearchTraceEntry = {
  message: AssistantMessage
  part: Part
  hidden?: boolean
}

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
const skills = new Set(["skill"])

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
  if (family === "skills") return `Using ${count} ${count === 1 ? "skill" : "skills"}`
  return `Completed ${count} research ${count === 1 ? "operation" : "operations"}`
}

export function compact(values: string[], limit = 3) {
  const unique = [...new Set(values)]
  const visible = unique.slice(0, limit)
  const hidden = unique.length - visible.length
  return [visible.join(" · "), hidden > 0 ? `+${hidden} more` : undefined].filter(Boolean).join(" · ")
}

function lifecycle(part: Part) {
  return part.type === "step-start" || part.type === "step-finish" || part.type === "snapshot" || part.type === "patch"
}

/**
 * Keep received prose and tool calls unchanged and chronological. Only
 * lifecycle markers, unreadable reasoning, and entries presented elsewhere are omitted; streaming
 * reconciliation replaces a duplicate part ID without moving its position.
 */
export function visibleResearchTrace(entries: ResearchTraceEntry[]): ResearchTraceEntry[] {
  const positions = new Map<string, number>()
  const deduped: ResearchTraceEntry[] = []
  for (const entry of entries) {
    const position = positions.get(entry.part.id)
    if (position === undefined) {
      positions.set(entry.part.id, deduped.length)
      deduped.push(entry)
      continue
    }
    deduped[position] = entry
  }
  return deduped.filter((entry) => {
    if (entry.hidden || lifecycle(entry.part)) return false
    return entry.part.type !== "reasoning" || !!stripRedactedReasoning(entry.part.text ?? "")
  })
}

export function summarizeTaskActivity(items: TaskActivity[]): TaskActivityGroup[] {
  const groups = new Map<TraceFamily, TaskActivityGroup & { titles: string[] }>()
  for (const item of items) {
    const directSkill = item.tool === "skill" && item.state.title?.startsWith("Loaded skill: ")
    if (item.tool === "skill" && !directSkill) continue
    const family = traceFamily(item.tool)
    const previous = groups.get(family)
    const title = directSkill ? item.state.title?.replace(/^Loaded skill:\s*/, "") : item.state.title
    const titles = title?.trim() ? [...(previous?.titles ?? []), title.trim()] : (previous?.titles ?? [])
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

/** Whole seconds for a counter that is still ticking. */
export function elapsedLabel(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatTaskDuration(value?: number) {
  if (value === undefined) return undefined
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
  return `${Math.floor(value / 3_600_000)}h ${Math.round((value % 3_600_000) / 60_000)}m`
}
