import type { AssistantMessage, Part } from "@synsci/sdk/v2/client"
import { loadedSkillName, privateReasoningOnly, reasoningDisplayText } from "./tool-display"

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
const sources = new Set(["webfetch", "websearch", "research_search", "science_fetch", "science_search", "atlas"])
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

function traceLabel(family: TraceFamily, count: number) {
  const noun = (one: string, many: string) => `${count} ${count === 1 ? one : many}`
  if (family === "context") return `Read ${noun("file", "files")}`
  if (family === "sources") return `Searched ${noun("source", "sources")}`
  if (family === "commands") return `Ran ${noun("command", "commands")}`
  if (family === "changes") return `Edited ${noun("file", "files")}`
  if (family === "images") return `Generated ${noun("image", "images")}`
  if (family === "skills") return `Loaded ${noun("skill", "skills")}`
  return `Completed ${noun("operation", "operations")}`
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

/** Collapsing activity must not bury deliverables, skill load receipts, failures,
 * or a question the user is still answering. Keep their original IDs mounted. */
export function collapsibleTracePart(
  part: Part,
  pendingRequestCallID?: string,
  pendingChildRequest?: (sessionID: string) => boolean,
) {
  if (part.type === "reasoning") return true
  if (part.type !== "tool") return false
  if (part.callID === pendingRequestCallID || part.state.status === "error") return false
  const child = part.tool === "task" && "metadata" in part.state ? part.state.metadata?.sessionId : undefined
  if (typeof child === "string" && pendingChildRequest?.(child)) return false
  if (part.state.status !== "completed") return true
  if (part.state.metadata?.ok === false) return false
  if (
    part.tool === "research_search" &&
    (part.state.metadata?.stopReason === "search_unavailable" ||
      part.state.metadata?.stopReason === "search_output_unavailable")
  )
    return false
  if (part.tool === "skill" && loadedSkillName(part.state)) return false
  const outcome = part.tool === "task" ? part.state.metadata?.outcome : undefined
  if (outcome === "error" || outcome === "timed_out" || outcome === "partial") return false
  if (part.state.metadata?.artifact) return false
  if (part.tool === "bash" && typeof part.state.metadata?.exit === "number" && part.state.metadata.exit !== 0)
    return false
  return true
}

/**
 * Keep received prose and tool calls unchanged and chronological. Only
 * lifecycle markers, empty reasoning, and entries presented elsewhere are omitted; private-only
 * reasoning keeps an availability notice without exposing provider continuation. Streaming
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
    return (
      entry.part.type !== "reasoning" ||
      !!reasoningDisplayText(entry.part.text ?? "") ||
      privateReasoningOnly(entry.part.text ?? "")
    )
  })
}

export function summarizeTaskActivity(items: TaskActivity[]): TaskActivityGroup[] {
  const groups = new Map<TraceFamily, TaskActivityGroup & { titles: string[] }>()
  for (const item of items) {
    const directSkill = item.tool === "skill" && loadedSkillName(item.state)
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

export type TaskHandoff = {
  /** Runtime notes about how the worker stopped, without their brackets. */
  notes: string[]
  /** The worker's own findings, ready for Markdown. */
  text: string
  /** Files the worker saved as immutable Results. */
  outputs: { filename: string; artifactID?: string }[]
  /** Whether `text` opens with its own heading, so a caller need not add one. */
  headed: boolean
}

const sessionLine = /^Task session ses_\w+: .*Reuse this sessionId to continue the same worker\.$/
const savedOutput = /^- "((?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*)": artifact_id=(\S+?),/
const receipts = /^Execution receipts: /

/**
 * The Task tool's output is written for the lead model: a session line to
 * continue the worker, bracketed stop notes, the findings, then evidence the
 * lead can act on. The card shows only what a reader needs.
 */
export function parseTaskHandoff(value?: string): TaskHandoff {
  const lines = stripTaskMetadata(value).split("\n")
  const notes: string[] = []
  const outputs: TaskHandoff["outputs"] = []
  const body: string[] = []
  let leading = true
  let saved = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (leading && trimmed === "") continue
    if (leading && sessionLine.test(trimmed)) continue
    if (leading && /^\[.*\]$/.test(trimmed)) {
      notes.push(trimmed.slice(1, -1))
      continue
    }
    leading = false
    if (trimmed.startsWith("Saved outputs (immutable versions;")) {
      saved = true
      continue
    }
    if (saved) {
      const match = savedOutput.exec(trimmed)
      if (match) {
        outputs.push({ filename: JSON.parse(`"${match[1]}"`), artifactID: match[2] })
        continue
      }
      saved = false
    }
    if (receipts.test(trimmed)) continue
    body.push(line)
  }
  const text = body.join("\n").trim()
  return { notes, text, outputs, headed: /^#{1,6}\s/.test(text) }
}

export function pluralize(count: number, noun: string, plural = `${noun}s`) {
  return `${count} ${count === 1 ? noun : plural}`
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
