import type { MessageV2 } from "./message-v2"

export type ObservableToolStatus = "pending" | "running" | "completed" | "partial" | "error"

function metadata(part: MessageV2.ToolPart): Record<string, unknown> {
  if (part.state.status !== "completed") return {}
  return part.state.metadata ?? {}
}

/** Normalize transport completion into the execution outcome shown to users
 * and lead agents. Commands and scientific runtimes return useful output even
 * on failure, so their actual outcome is carried in metadata. */
export function observableToolStatus(part: MessageV2.ToolPart): ObservableToolStatus {
  if (part.state.status !== "completed") return part.state.status
  const meta = metadata(part)
  if (meta.outcome === "partial") return "partial"
  if (part.tool === "task") {
    if (meta.stopReason === "max_steps") return "partial"
    if (meta.outcome === "timed_out" || meta.outcome === "error") return "error"
  }
  if (meta.ok === false) return "error"
  if (part.tool === "bash" && "exit" in meta && meta.exit !== 0) return "error"
  return "completed"
}

/** Tools that only observe: an interruption leaves nothing behind to check. */
const OBSERVERS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "codesearch",
  "lsp",
  "webfetch",
  "websearch",
  "research_search",
  "literature",
  "recall",
  "science_search",
  "science_fetch",
  "science_list_dbs",
  "skill",
])

/** What an interrupted call did or did not do, stated for the tool rather than
 * in general. A budget question that was cut off must not read as "its side
 * effects may have completed": nothing was chosen and nothing was recorded,
 * and the model should simply ask again. */
export function interruptionReceipt(tool: string, started: boolean) {
  if (tool === "question") {
    return started
      ? "The question was shown but no answer arrived before the interruption: no option was chosen and nothing was recorded. Ask again if the decision is still open."
      : "The question had not been shown; nothing was asked or recorded."
  }
  if (!started) return `The ${tool} call had not started; no action was taken.`
  if (OBSERVERS.has(tool)) return `The ${tool} call only reads; nothing changed.`
  return "Its side effects may have completed; inspect the current state before retrying."
}

/** Close a tool wrapper whose executor will never report. A call that never
 * left `pending` did nothing: its record must say so and carry the cause,
 * rather than read as a failed execution with empty arguments. `explain`
 * appends the receipt when `reason` does not already state it; a running call
 * gets one only where the tool's nature makes it exact (a question, a read). */
export function abortedToolPart(
  part: MessageV2.ToolPart,
  reason: string,
  options: { now?: number; explain?: boolean } = {},
): MessageV2.ToolPart {
  const now = options.now ?? Date.now()
  const running = part.state.status === "running" ? part.state : undefined
  const start = running ? running.time.start : now
  const exact = part.tool === "question" || OBSERVERS.has(part.tool)
  const detail =
    options.explain === false || (running && !exact) ? "" : `. ${interruptionReceipt(part.tool, !!running)}`
  return {
    ...part,
    state: {
      status: "error",
      input: part.state.input,
      raw: part.state.raw,
      metadata: { ...running?.metadata, cancelled: true, started: !!running },
      error: `${reason}${detail}`,
      time: { start, end: Math.max(start, now) },
    },
  }
}

export function observableToolFailure(part: MessageV2.ToolPart) {
  if (part.state.status === "error") return part.state.error
  if (part.state.status !== "completed") return
  const meta = metadata(part)
  const title = part.state.title.replace(/\s+\(error\)$/i, "").trim() || part.tool
  if (part.tool === "task") {
    if (meta.outcome === "timed_out") return `${title} timed out`
    if (meta.outcome === "error") return `${title} failed`
    return
  }
  if (meta.ok === false) return `${title} reported failure`
  if (part.tool !== "bash" || !("exit" in meta) || meta.exit === 0) return
  if (typeof meta.exit === "number") return `${title} exited with code ${meta.exit}`
  return `${title} did not return a successful exit code`
}
