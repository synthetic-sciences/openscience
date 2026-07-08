import type { Session } from "@synsci/sdk/v2/client"

type StatusKind = "active" | "pending" | "done" | "error"
type Status = { type: string } | undefined

export type SubagentRow = { sessionId: string; title: string; status: StatusKind; updated: number }

export function subagentStatusKind(status: Status): StatusKind {
  if (!status) return "done"
  if (status.type === "busy") return "active"
  if (status.type === "retry") return "pending"
  return "done"
}

export function activeSubagents(
  sessions: Session[],
  statuses: Record<string, Status>,
  parentId: string,
): SubagentRow[] {
  return sessions
    .filter((session) => session.parentID === parentId)
    .map((session) => ({
      sessionId: session.id,
      title: session.title,
      status: subagentStatusKind(statuses[session.id]),
      updated: session.time?.updated ?? 0,
    }))
    .sort((a, b) => b.updated - a.updated)
}

export function activeCount(rows: SubagentRow[]): number {
  return rows.filter((r) => r.status === "active").length
}
