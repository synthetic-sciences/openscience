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
