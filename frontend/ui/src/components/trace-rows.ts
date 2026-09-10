import type { Part, ToolPart } from "@synsci/sdk/v2/client"
import type { ResearchTraceEntry } from "./research-trace"
import { collapsibleTracePart, traceFamily } from "./research-trace"

/**
 * The activity trace as a list of rows, the way Cursor presents work: one
 * line per thought, per delegated agent, per exploratory burst ("Explored 4
 * files, ran 2 commands") and per batch of edits, with narration in between.
 * Anything still running, failed, or waiting on the user stays its own row so
 * live progress and problems are never folded into a count.
 */
export type TraceRow =
  | { kind: "thought"; entry: ResearchTraceEntry; seconds?: number }
  | { kind: "text"; entry: ResearchTraceEntry; narration: boolean }
  | { kind: "agent"; entry: ResearchTraceEntry }
  | { kind: "tool"; entry: ResearchTraceEntry }
  | { kind: "explored"; entries: ResearchTraceEntry[]; files: number; sources: number; commands: number }
  | { kind: "edited"; entries: ResearchTraceEntry[]; files: string[] }

const groupable = new Set(["context", "sources", "commands"])

/** Finished quietly: no failure, no receipt the reader must see on its own. */
function settled(part: ToolPart) {
  return part.state.status === "completed" && collapsibleTracePart(part)
}

function editedFile(part: ToolPart) {
  const input = part.state.input as Record<string, unknown> | undefined
  const path = typeof input?.filePath === "string" ? input.filePath : undefined
  if (path) return path.split("/").pop() || path
  const files = Array.isArray(input?.files) ? input.files : []
  return files.length ? `${files.length} files` : "files"
}

function thoughtSeconds(part: Part) {
  if (part.type !== "reasoning") return undefined
  const time = part.time
  if (!time?.start || !time.end) return undefined
  return Math.max(0, Math.round((time.end - time.start) / 1000))
}

export function buildTraceRows(entries: ResearchTraceEntry[]): TraceRow[] {
  const rows: TraceRow[] = []
  // Text that arrives before later work is narration: it belongs to the
  // trace, not to the response the collapsed turn shows. The last text is
  // always the response, even when a late save or receipt follows it.
  const lastWork = entries.findLastIndex((entry) => entry.part.type !== "text")
  const lastText = entries.findLastIndex((entry) => entry.part.type === "text")
  entries.forEach((entry, index) => {
    const part = entry.part
    if (part.type === "reasoning") {
      rows.push({ kind: "thought", entry, seconds: thoughtSeconds(part) })
      return
    }
    if (part.type === "text") {
      rows.push({ kind: "text", entry, narration: index < lastWork && index < lastText })
      return
    }
    if (part.type !== "tool") {
      rows.push({ kind: "tool", entry })
      return
    }
    if (part.tool === "task") {
      rows.push({ kind: "agent", entry })
      return
    }
    const family = traceFamily(part.tool)
    const previous = rows.at(-1)
    if (family === "changes" && settled(part)) {
      if (previous?.kind === "edited") {
        previous.entries.push(entry)
        previous.files.push(editedFile(part))
        return
      }
      rows.push({ kind: "edited", entries: [entry], files: [editedFile(part)] })
      return
    }
    if (groupable.has(family) && settled(part)) {
      const target =
        previous?.kind === "explored"
          ? previous
          : (() => {
              const created = { kind: "explored" as const, entries: [], files: 0, sources: 0, commands: 0 }
              rows.push(created)
              return created
            })()
      target.entries.push(entry)
      if (family === "context") target.files++
      if (family === "sources") target.sources++
      if (family === "commands") target.commands++
      return
    }
    rows.push({ kind: "tool", entry })
  })
  return rows
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

/** "Explored 4 files, ran 2 commands" / "Ran 3 commands" / "Read 2 files". */
export function exploredLabel(row: Extract<TraceRow, { kind: "explored" }>) {
  const files = row.files ? plural(row.files, "file", "files") : undefined
  const sources = row.sources ? plural(row.sources, "source", "sources") : undefined
  const commands = row.commands ? plural(row.commands, "command", "commands") : undefined
  if (files === undefined && sources === undefined && commands) return `Ran ${commands}`
  if (files && sources === undefined && commands === undefined) return `Read ${files}`
  if (sources && files === undefined && commands === undefined) return `Searched ${sources}`
  const parts = [files, sources].filter((value): value is string => !!value).join(", ")
  return `Explored ${parts}${commands ? `${parts ? ", ran " : "ran "}${commands}` : ""}`
}

/** "Edited 3 files" or "Edited notes.md, plot.py". */
export function editedLabel(row: Extract<TraceRow, { kind: "edited" }>) {
  const unique = [...new Set(row.files)]
  if (unique.length <= 2) return `Edited ${unique.join(", ")}`
  return `Edited ${unique.length} files`
}

export function thoughtLabel(seconds: number | undefined, live: boolean) {
  if (live) return "Thinking"
  if (seconds === undefined) return "Thought"
  if (seconds < 1) return "Thought briefly"
  if (seconds < 60) return `Thought ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `Thought ${minutes}m ${rest}s` : `Thought ${minutes}m`
}
