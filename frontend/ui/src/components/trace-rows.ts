import type { Part, ToolPart } from "@synsci/sdk/v2/client"
import type { ResearchTraceEntry } from "./research-trace"
import { collapsibleTracePart, elapsedLabel, traceFamily } from "./research-trace"
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
  | { kind: "agent"; entry: ResearchTraceEntry }
  | { kind: "tool"; entry: ResearchTraceEntry }
  | { kind: "explored"; entries: ResearchTraceEntry[]; files: number; sources: number; commands: number }
  | { kind: "edited"; entries: ResearchTraceEntry[]; files: string[] }

const groupable = new Set(["context", "sources", "commands"])

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

/**
 * The trace folded the way a finished turn reads: the model's prose stays in
 * place at full size, and every burst of work between two paragraphs folds
 * into one line ("Read 4 files, edited 3 files · 4m 12s"). Reasoning the
 * provider kept private has nothing to open, so it is counted into the
 * burst's time instead of taking a row of its own.
 */
export type TraceSegment =
  | { kind: "text"; row: Extract<TraceRow, { kind: "text" }> }
  | {
      kind: "burst"
      key: string
      rows: TraceRow[]
      calls: number
      failed: number
      /** When the burst began: the earliest start any of its parts recorded. */
      start?: number
      /** When the burst ended; undefined while any part in it is still running. */
      end?: number
    }

function partTimes(part: Part): { start?: number; end?: number; open: boolean } {
  if (part.type === "tool") {
    const state = part.state
    if (state.status === "pending") return { open: true }
    if (state.status === "running") return { start: state.time.start, open: true }
    return { start: state.time.start, end: state.time.end, open: false }
  }
  if (part.type === "reasoning" || part.type === "text") {
    return { start: part.time?.start, end: part.time?.end, open: part.time?.start !== undefined && !part.time?.end }
  }
  return { open: false }
}

function rowEntries(row: TraceRow): ResearchTraceEntry[] {
  return "entries" in row ? row.entries : [row.entry]
}

function rowKey(row: TraceRow) {
  return "entries" in row ? `burst:${row.entries[0]!.part.id}` : row.entry.part.id
}

/** Whether a reasoning row has anything to show; a row that does not is a
 * private phase whose duration belongs to the burst, not to a line. */
export function privateThought(row: TraceRow, live: boolean) {
  return row.kind === "thought" && !row.readable && !live
}

export function buildTraceSegments(rows: TraceRow[], liveThought: (row: TraceRow) => boolean = () => false) {
  const segments: TraceSegment[] = []
  const members = new Map<TraceSegment, TraceRow[]>()
  let burst: Extract<TraceSegment, { kind: "burst" }> | undefined
  for (const row of rows) {
    if (row.kind === "text") {
      burst = undefined
      segments.push({ kind: "text", row })
      continue
    }
    if (!burst) {
      burst = { kind: "burst", key: `segment:${rowKey(row)}`, rows: [], calls: 0, failed: 0 }
      segments.push(burst)
      members.set(burst, [])
    }
    members.get(burst)!.push(row)
    if (!privateThought(row, liveThought(row))) burst.rows.push(row)
  }
  // The clock and the counts come from every part in the burst, private
  // thoughts included; only the rows shown leave them out.
  for (const segment of segments) {
    if (segment.kind !== "burst") continue
    const times = (members.get(segment) ?? []).flatMap(rowEntries).map((entry) => ({ entry, ...partTimes(entry.part) }))
    const starts = times.map((item) => item.start).filter((value): value is number => value !== undefined)
    const ends = times.map((item) => item.end).filter((value): value is number => value !== undefined)
    segment.start = starts.length ? Math.min(...starts) : undefined
    segment.end = times.some((item) => item.open) || !ends.length ? undefined : Math.max(...ends)
    for (const item of times) {
      if (item.entry.part.type !== "tool") continue
      segment.calls++
      if (item.entry.part.state.status === "error") segment.failed++
    }
  }
  return segments
}

/** "Read 4 files, edited 3 files, ran 2 commands · 1 failed · 4m 12s". */
export function burstLabel(segment: Extract<TraceSegment, { kind: "burst" }>, now: number) {
  const counts = {
    files: 0,
    sources: 0,
    commands: 0,
    edits: new Set<string>(),
    agents: 0,
    skills: 0,
    questions: 0,
    plans: 0,
    saves: 0,
    other: 0,
  }
  let thoughtOnly = true
  for (const row of segment.rows) {
    if (row.kind === "thought") continue
    thoughtOnly = false
    if (row.kind === "explored") {
      counts.files += row.files
      counts.sources += row.sources
      counts.commands += row.commands
      continue
    }
    if (row.kind === "edited") {
      for (const file of row.files) counts.edits.add(file)
      if (!row.files.length) counts.other += row.entries.length
      continue
    }
    if (row.kind === "agent") {
      counts.agents++
      continue
    }
    if (row.kind !== "tool" || row.entry.part.type !== "tool") continue
    const tool = row.entry.part.tool
    const family = traceFamily(tool)
    if (family === "context") counts.files++
    else if (family === "sources") counts.sources++
    else if (family === "commands") counts.commands++
    else if (family === "changes") counts.edits.add(row.entry.part.id)
    else if (family === "skills") counts.skills++
    else if (tool === "question") counts.questions++
    else if (tool === "todowrite") counts.plans++
    else if (tool === "artifact") counts.saves++
    else counts.other++
  }
  const noun = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const phrases = [
    counts.files ? `read ${noun(counts.files, "file", "files")}` : "",
    counts.sources ? `searched ${noun(counts.sources, "source", "sources")}` : "",
    counts.commands ? `ran ${noun(counts.commands, "command", "commands")}` : "",
    counts.edits.size ? `edited ${noun(counts.edits.size, "file", "files")}` : "",
    counts.agents ? `delegated ${noun(counts.agents, "task", "tasks")}` : "",
    counts.skills ? `loaded ${noun(counts.skills, "skill", "skills")}` : "",
    counts.questions ? `asked ${noun(counts.questions, "question", "questions")}` : "",
    counts.plans ? "updated the plan" : "",
    counts.saves ? `saved ${noun(counts.saves, "result", "results")}` : "",
    counts.other ? `used ${noun(counts.other, "tool", "tools")}` : "",
  ].filter(Boolean)
  const duration =
    segment.start === undefined ? undefined : elapsedLabel(Math.max(0, (segment.end ?? now) - segment.start))
  // A burst of thought alone reads like its row would: "Thought 1m 3s".
  if (!phrases.length && thoughtOnly)
    return segment.start === undefined
      ? "Thought"
      : thoughtLabel(Math.floor(Math.max(0, (segment.end ?? now) - segment.start) / 1000), false)
  const activity = phrases.length ? phrases.join(", ") : "worked"
  const head = activity.charAt(0).toUpperCase() + activity.slice(1)
  return [head, segment.failed ? noun(segment.failed, "failed", "failed") : "", duration ?? ""]
    .filter(Boolean)
    .join(" · ")
}
