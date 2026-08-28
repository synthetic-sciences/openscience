import type { AssistantMessage, Part, ToolPart, ToolStateCompleted } from "@synsci/sdk/v2/client"
import { reasoningDisplayText, reasoningTopic, skillName } from "./tool-display"

export type ResearchTraceEntry = {
  message: AssistantMessage
  part: Part
  hidden?: boolean
  /** Adjacent, low-value successful preflights kept behind one disclosure. */
  group?: ResearchTraceEntry[]
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

function compact(values: string[], limit = 3) {
  const unique = [...new Set(values)]
  const visible = unique.slice(0, limit)
  const hidden = unique.length - visible.length
  return [visible.join(" · "), hidden > 0 ? `+${hidden} more` : undefined].filter(Boolean).join(" · ")
}

function lifecycle(part: Part) {
  return part.type === "step-start" || part.type === "step-finish" || part.type === "snapshot" || part.type === "patch"
}

type CompletedSkillEntry = ResearchTraceEntry & {
  part: ToolPart & { state: ToolStateCompleted }
}

function completedSkillLoad(entry: ResearchTraceEntry): entry is CompletedSkillEntry {
  if (entry.part.type !== "tool" || entry.part.tool !== "skill" || entry.part.state.status !== "completed") return false
  return !!skillName({
    input: (entry.part.state.input ?? {}) as Record<string, unknown>,
    metadata: (entry.part.state.metadata ?? {}) as Record<string, unknown>,
    title: entry.part.state.title,
  })
}

function completedSkillSearch(entry: ResearchTraceEntry): entry is CompletedSkillEntry {
  if (entry.part.type !== "tool" || entry.part.tool !== "skill" || entry.part.state.status !== "completed") return false
  const input = (entry.part.state.input ?? {}) as Record<string, unknown>
  return !completedSkillLoad(entry) && (typeof input.query === "string" || typeof input.category === "string")
}

function skillMatches(entry: CompletedSkillEntry) {
  const metadata = (entry.part.state.metadata ?? {}) as Record<string, unknown>
  return Array.isArray(metadata.matches)
    ? metadata.matches.filter((name): name is string => typeof name === "string" && !!name)
    : []
}

function completedShellPreflight(entry: ResearchTraceEntry) {
  if (entry.part.type !== "tool" || entry.part.tool !== "bash" || entry.part.state.status !== "completed") return false
  const input = (entry.part.state.input ?? {}) as Record<string, unknown>
  const command = typeof input.command === "string" ? input.command.trim() : ""
  return [
    /^pwd$/,
    /^(?:which|command\s+-v)\s+[A-Za-z0-9._+/-]+$/,
    /^git\s+status(?:\s+(?:--short|--porcelain(?:=v[12])?))?$/,
    /^git\s+rev-parse\s+(?:--show-toplevel|--is-inside-work-tree|--show-prefix|HEAD)$/,
    /^[A-Za-z0-9._+/-]+\s+--version$/,
  ].some((pattern) => pattern.test(command))
}

/**
 * Keep the primary activity transcript literal and chronological. Streaming
 * state changes must not replace already-visible rows with aggregate summaries;
 * The sole inline compaction is a run of low-value, successful shell
 * preflights. The original calls remain in `group` so expansion never hides
 * commands or output; errors and substantive work always remain literal.
 */
export function visibleResearchTrace(entries: ResearchTraceEntry[]): ResearchTraceEntry[] {
  // Streaming reconciliation can briefly surface the same durable part twice
  // while an insert and update are coalesced. Keep the first chronological
  // position but render the newest value for that stable part ID.
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

  const visible = deduped.filter((entry) => {
    if (entry.hidden || lifecycle(entry.part)) return false
    if (
      entry.part.type === "reasoning" &&
      !reasoningDisplayText(entry.part.text ?? "") &&
      !reasoningTopic(entry.part.text ?? "")
    )
      return false
    return true
  })
  const result: ResearchTraceEntry[] = []
  for (let index = 0; index < visible.length; index++) {
    const first = visible[index]!
    if (completedSkillSearch(first)) {
      const group: CompletedSkillEntry[] = [first]
      while (index + 1 < visible.length) {
        const next = visible[index + 1]!
        if (!completedSkillSearch(next)) break
        group.push(next)
        index++
      }
      if (group.length === 1) {
        result.push(first)
        continue
      }
      const matches = [...new Set(group.flatMap(skillMatches))]
      result.push({
        message: first.message,
        part: {
          ...first.part,
          state: {
            ...first.part.state,
            title: "Skill matches",
            input: { query: "relevant scientific capabilities" },
            output: matches.map((name) => `- ${name}`).join("\n"),
            metadata: { matches },
          },
        },
      })
      continue
    }
    if (completedShellPreflight(first)) {
      const group: ResearchTraceEntry[] = [first]
      while (index + 1 < visible.length) {
        const next = visible[index + 1]!
        if (!completedShellPreflight(next)) break
        group.push(next)
        index++
      }
      if (group.length > 1) {
        result.push({ ...first, group })
        continue
      }
    }
    if (!completedSkillLoad(first)) {
      result.push(first)
      continue
    }
    const group: CompletedSkillEntry[] = [first]
    while (index + 1 < visible.length) {
      const next = visible[index + 1]!
      if (!completedSkillLoad(next)) break
      group.push(next)
      index++
    }
    if (group.length === 1) {
      result.push(first)
      continue
    }
    const names = [
      ...new Set(
        group
          .map((entry) =>
            skillName({
              input: (entry.part.state.input ?? {}) as Record<string, unknown>,
              metadata: (entry.part.state.metadata ?? {}) as Record<string, unknown>,
              title: entry.part.state.title,
            }),
          )
          .filter((name): name is string => !!name),
      ),
    ]
    result.push({
      message: first.message,
      part: {
        ...first.part,
        state: {
          ...first.part.state,
          title: `Using ${names.length} ${names.length === 1 ? "skill" : "skills"}`,
          input: {},
          output: names.map((name) => `- ${name}`).join("\n"),
          metadata: { names },
        },
      },
    })
  }
  return result
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

export function formatTaskDuration(value?: number) {
  if (value === undefined) return undefined
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
  return `${Math.floor(value / 3_600_000)}h ${Math.round((value % 3_600_000) / 60_000)}m`
}
