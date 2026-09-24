import type { Part, ToolPart } from "@synsci/sdk/v2/client"
import type { ResearchTraceEntry } from "./research-trace"
import { collapsibleTracePart, settledCollapsible, traceFamily } from "./research-trace"
import { toolChanges, writtenFiles, reasoningDisplayText } from "./tool-display"

/**
 * The activity trace as a list of rows, the way Cursor presents work: one
 * line per thought, per delegated agent, per exploratory burst ("Explored 4
 * files, ran 2 commands") and per batch of edits, with narration in between.
 * Anything still running, failed, or waiting on the user stays its own row so
 * live progress and problems are never folded into a count.
 */
export type TraceRow =
  | { kind: "thought"; entries: ResearchTraceEntry[]; seconds?: number; readable: boolean }
  | { kind: "text"; entry: ResearchTraceEntry; narration: boolean }
  /** A message the harness wrote into the turn (a worker's result, a
   * deliverables check, a budget reminder), shown as one grey line so the
   * reader sees why the agent went on after it had answered. */
  | { kind: "note"; entry: ResearchTraceEntry; text: string; details?: boolean }
  | { kind: "agent"; entry: ResearchTraceEntry }
  | { kind: "tool"; entry: ResearchTraceEntry }
  | { kind: "explored"; entries: ResearchTraceEntry[]; files: number; sources: number; commands: number }
  | { kind: "edited"; entries: ResearchTraceEntry[]; files: string[] }

const groupable = new Set(["context", "sources", "commands"])

/** The one line for a compaction that fired mid-turn. */
export const COMPACTED_NOTE =
  "Context compacted. The conversation so far was folded into a handoff and the work continued from it."

/** The runtime's own instruction to continue after a compaction. It is the
 * compaction's second half, not a note for the reader. */
const COMPACTION_CONTINUATION = /^Continue from the ['‘]Next Move['’] in the handoff above\b/

function tokens(value: number) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(value)
}

/** "Context compacted · 92K → 6.1K tokens" once the sizes are known. */
export function compactedLabel(part: { before?: number; after?: number }) {
  if (part.before === undefined || part.after === undefined || part.before <= 0) return "Context compacted."
  return `Context compacted · ${tokens(part.before)} → ${tokens(part.after)} tokens`
}

/** Finished quietly: no failure, no receipt the reader must see on its own. */
function settled(part: ToolPart) {
  return part.state.status === "completed" && collapsibleTracePart(part)
}

function editedFiles(part: ToolPart) {
  if (part.tool === "apply_patch" && part.state.status === "completed" && Array.isArray(part.state.metadata.files)) {
    return part.state.metadata.files.flatMap((file: unknown) => {
      if (!file || typeof file !== "object") return []
      const record = file as Record<string, unknown>
      const path = record.movePath ?? record.filePath
      return typeof path === "string" ? [path] : []
    })
  }
  return writtenFiles([part])
}

export function editedChanges(row: Extract<TraceRow, { kind: "edited" }>) {
  const total = { additions: 0, deletions: 0 }
  for (const entry of row.entries) {
    if (entry.part.type !== "tool") return
    const changes = toolChanges(entry.part.state)
    // Older receipts may lack counts. An incomplete sum would understate the work.
    if (!changes) return
    total.additions += changes.additions
    total.deletions += changes.deletions
  }
  return total
}

function thoughtSeconds(part: Part) {
  if (part.type !== "reasoning") return undefined
  const time = part.time
  if (time?.start === undefined || time.end === undefined) return undefined
  return Math.max(0, Math.round((time.end - time.start) / 1000))
}

const readableText = (entry: ResearchTraceEntry) =>
  entry.part.type === "reasoning" && !!reasoningDisplayText(entry.part.text ?? "")

/** The text a completed answer ended with: the last text of a message whose
 * response finished, rather than one that went on to call tools. When the
 * harness continues the turn afterwards (a deliverables check, a budget
 * reminder, a worker's result), that answer is still the answer the reader
 * was given, not narration to fold away. */
function answered(entries: ResearchTraceEntry[], index: number) {
  const entry = entries[index]!
  const finish = entry.message.finish
  if (!finish || finish === "tool-calls" || finish === "unknown") return false
  return !entries.some(
    (other, position) => position > index && other.message.id === entry.message.id && other.part.type === "text",
  )
}

export function buildTraceRows(entries: ResearchTraceEntry[]): TraceRow[] {
  const rows: TraceRow[] = []
  // Text that arrives before later work is narration: it belongs to the
  // trace, not to the response the collapsed turn shows. The last text is
  // always the response, even when a late save or receipt follows it, and so
  // is every answer a finished response ended with.
  const lastWork = entries.findLastIndex((entry) => entry.part.type !== "text")
  const lastText = entries.findLastIndex((entry) => entry.part.type === "text")
  entries.forEach((entry, index) => {
    const part = entry.part
    if (part.type === "text" && part.synthetic) {
      const text = part.text.replace(/<\/?system-reminder[^>]*>/g, "").trim()
      if (text && !COMPACTION_CONTINUATION.test(text))
        rows.push({ kind: "note", entry, text, details: /^Tools (?:added|removed):/.test(text) })
      return
    }
    // An automatic compaction inside the turn: the reader sees where the
    // context was folded into a handoff, how much it shrank, and that the
    // work went on from it.
    if (part.type === "compaction") {
      const sized = part as { before?: number; after?: number }
      const label = compactedLabel(sized)
      rows.push({
        kind: "note",
        entry,
        text:
          label === "Context compacted."
            ? COMPACTED_NOTE
            : `${label}. ${COMPACTED_NOTE.slice("Context compacted. ".length)}`,
      })
      return
    }
    if (part.type === "reasoning") {
      const previous = rows.at(-1)
      const seconds = thoughtSeconds(part)
      // Providers can split one reasoning phase into a readable summary and
      // several private continuation parts. Keep their detail in one row.
      if (previous?.kind === "thought") {
        previous.entries.push(entry)
        previous.seconds = seconds === undefined ? previous.seconds : (previous.seconds ?? 0) + seconds
        previous.readable = previous.readable || readableText(entry)
        return
      }
      // A phase the provider kept entirely private still took its time: the
      // row keeps the duration and has nothing to open.
      rows.push({ kind: "thought", entries: [entry], seconds, readable: readableText(entry) })
      return
    }
    if (part.type === "text") {
      rows.push({
        kind: "text",
        entry,
        narration: index < lastWork && index < lastText && !answered(entries, index),
      })
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
        previous.files.push(...editedFiles(part))
        return
      }
      rows.push({ kind: "edited", entries: [entry], files: editedFiles(part) })
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

/**
 * The rows a collapsed turn shows: the answer, plus anything that still
 * needs the reader (a pending request, a saved Result). A failure is the
 * agent's to deal with while it works and part of the story once it has
 * answered, so neither state shows a failure folded; only a turn that
 * stopped without an answer shows the failures of its final step, which are
 * what stopped it. Harness notes fold once the turn has answered.
 */
export function collapsedTraceRows(
  rows: TraceRow[],
  state: {
    working: boolean
    settled: boolean
    /** The id of the turn's last assistant message: the step a stop happened in. */
    final?: string
    pendingRequestCallID?: string
    pendingChildRequest?: (sessionID: string) => boolean
  },
): TraceRow[] {
  const stopped = !state.working && !state.settled
  return rows.filter((row) => {
    if (row.kind === "text") return !row.narration
    // Tool availability is context for the model, not a progress update or a
    // request for the reader. Keep it available in the expanded activity trace.
    if (row.kind === "note") return !state.settled && !row.details
    if (row.kind === "tool" || row.kind === "agent") {
      if (stopped && row.entry.message.id === state.final)
        return !collapsibleTracePart(row.entry.part, state.pendingRequestCallID, state.pendingChildRequest)
      return !settledCollapsible(row.entry.part, state.pendingRequestCallID, state.pendingChildRequest)
    }
    return false
  })
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
  if (!unique.length) return `Applied ${plural(row.entries.length, "edit", "edits")}`
  if (unique.length <= 2) return `Edited ${unique.map((file) => file.split(/[\\/]/).at(-1) || file).join(", ")}`
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

/** One line for a harness message: a worker's result names the worker, a
 * check or reminder keeps its first sentence. */
export function noteLabel(text: string) {
  const task = text.match(/<task\b[^>]*\bstate="([^"]+)"/)
  if (task) {
    const state = task[1]
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
    const first = summary?.split(/(?<=[.!?])\s+/)[0]?.trim()
    return `Worker ${state}${first ? `: ${first}` : ""}`
  }
  const flat = text
    .replace(/<\/?system-reminder[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const first = flat.split(/(?<=[.!?])\s+/)[0]?.trim() ?? flat
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first
}
