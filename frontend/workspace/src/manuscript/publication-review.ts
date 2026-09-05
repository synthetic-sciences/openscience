// Publication preflight: the deterministic manuscript review the workbench
// shows before a write-up is finalized.

export type PublicationReviewKind =
  "not-applicable" | "not-run" | "blocked" | "warnings" | "ready" | "finalized" | "stale"

export type PublicationReviewCheck = "citation" | "numeric" | "figure" | "provenance"

export type PublicationReviewSeverity = "blocking" | "major" | "minor" | "info"

export type PublicationReviewFindingStatus = "open" | "resolved" | "overridden"

export interface PublicationReviewFinding {
  id: string
  check: PublicationReviewCheck
  severity: PublicationReviewSeverity
  status: PublicationReviewFindingStatus
  title: string
  detail: string
  evidence: string[]
  location: { path: string; line?: number }
  resolution?: {
    kind: "resolved" | "overridden"
    actor: string
    reason: string
    at: number
  }
}

export interface PublicationReviewReport {
  format: "openscience.publication-review.v1"
  id: string
  path: string
  artifactHash: string
  version: number
  status: "blocked" | "warnings" | "ready"
  stale: boolean
  summary: {
    total: number
    open: number
    blocking: number
    major: number
    minor: number
    info: number
    resolved: number
    overridden: number
  }
  findings: PublicationReviewFinding[]
  events: Array<{
    version: number
    type: "generated" | "resolved" | "overridden" | "finalized"
    actor: string
    at: number
    findingID?: string
    reason?: string
  }>
  finalized?: {
    actor: string
    at: number
    artifactHash: string
  }
  createdAt: number
  updatedAt: number
}

export interface PublicationReviewState {
  kind: PublicationReviewKind
  title: string
  detail: string
  report?: PublicationReviewReport
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function reviewFinding(value: unknown): PublicationReviewFinding | undefined {
  const row = record(value)
  const location = record(row?.location)
  const resolution = record(row?.resolution)
  const checks = new Set(["citation", "numeric", "figure", "provenance"])
  const severities = new Set(["blocking", "major", "minor", "info"])
  const statuses = new Set(["open", "resolved", "overridden"])
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.check !== "string" ||
    !checks.has(row.check) ||
    typeof row.severity !== "string" ||
    !severities.has(row.severity) ||
    typeof row.status !== "string" ||
    !statuses.has(row.status) ||
    typeof row.title !== "string" ||
    typeof row.detail !== "string" ||
    !Array.isArray(row.evidence) ||
    !row.evidence.every((item) => typeof item === "string") ||
    !location ||
    typeof location.path !== "string"
  )
    return
  const parsed =
    resolution &&
    (resolution.kind === "resolved" || resolution.kind === "overridden") &&
    typeof resolution.actor === "string" &&
    typeof resolution.reason === "string" &&
    typeof resolution.at === "number"
      ? {
          kind: resolution.kind as "resolved" | "overridden",
          actor: resolution.actor,
          reason: resolution.reason,
          at: resolution.at,
        }
      : undefined
  if (row.resolution !== undefined && !parsed) return
  return {
    id: row.id,
    check: row.check as PublicationReviewCheck,
    severity: row.severity as PublicationReviewSeverity,
    status: row.status as PublicationReviewFindingStatus,
    title: row.title,
    detail: row.detail,
    evidence: row.evidence as string[],
    location: {
      path: location.path,
      ...(typeof location.line === "number" ? { line: location.line } : {}),
    },
    ...(parsed ? { resolution: parsed } : {}),
  }
}

function review(value: unknown): PublicationReviewReport | undefined {
  const row = record(value)
  if (!row) return
  const statuses = new Set(["blocked", "warnings", "ready"])
  if (
    row.format !== "openscience.publication-review.v1" ||
    typeof row.id !== "string" ||
    typeof row.path !== "string" ||
    typeof row.artifactHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.artifactHash) ||
    typeof row.version !== "number" ||
    typeof row.status !== "string" ||
    !statuses.has(row.status) ||
    typeof row.stale !== "boolean" ||
    typeof row.createdAt !== "number" ||
    typeof row.updatedAt !== "number" ||
    !Array.isArray(row.findings) ||
    !Array.isArray(row.events)
  )
    return
  const summary = record(row.summary)
  if (
    !summary ||
    !["total", "open", "blocking", "major", "minor", "info", "resolved", "overridden"].every(
      (key) => typeof summary[key] === "number",
    )
  )
    return
  const findings = row.findings.map(reviewFinding)
  if (findings.some((finding) => !finding)) return
  const events = row.events.flatMap((item) => {
    const event = record(item)
    const types = new Set(["generated", "resolved", "overridden", "finalized"])
    if (
      !event ||
      typeof event.version !== "number" ||
      typeof event.type !== "string" ||
      !types.has(event.type) ||
      typeof event.actor !== "string" ||
      typeof event.at !== "number"
    )
      return []
    return [
      {
        version: event.version,
        type: event.type as PublicationReviewReport["events"][number]["type"],
        actor: event.actor,
        at: event.at,
        ...(typeof event.findingID === "string" ? { findingID: event.findingID } : {}),
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      },
    ]
  })
  if (events.length !== row.events.length) return
  const final = record(row.finalized)
  const finalized =
    final &&
    typeof final.actor === "string" &&
    typeof final.at === "number" &&
    typeof final.artifactHash === "string" &&
    /^[a-f0-9]{64}$/.test(final.artifactHash)
      ? { actor: final.actor, at: final.at, artifactHash: final.artifactHash }
      : undefined
  if (row.finalized !== undefined && !finalized) return
  return {
    format: "openscience.publication-review.v1",
    id: row.id,
    path: row.path,
    artifactHash: row.artifactHash,
    version: row.version,
    status: row.status as PublicationReviewReport["status"],
    stale: row.stale,
    summary: {
      total: summary.total as number,
      open: summary.open as number,
      blocking: summary.blocking as number,
      major: summary.major as number,
      minor: summary.minor as number,
      info: summary.info as number,
      resolved: summary.resolved as number,
      overridden: summary.overridden as number,
    },
    findings: findings as PublicationReviewFinding[],
    events,
    ...(finalized ? { finalized } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function normalizePublicationReview(format: string, value: unknown): PublicationReviewState {
  if (!["md", "markdown"].includes(format.toLowerCase())) {
    return {
      kind: "not-applicable",
      title: "Publication checks do not apply",
      detail: "Deterministic publication readiness currently applies to Markdown manuscripts.",
    }
  }
  const report = review(value)
  if (!report) {
    return {
      kind: "not-run",
      title: "No publication preflight yet",
      detail: "Run deterministic citation, numeric, figure, and provenance checks against this manuscript.",
    }
  }
  if (report.stale) {
    return {
      kind: "stale",
      title: "Preflight is stale",
      detail: "The manuscript changed after this report was generated. Run the checks again.",
      report,
    }
  }
  if (report.finalized) {
    return {
      kind: "finalized",
      title: report.status === "ready" ? "Publication preflight finalized" : "Finalized with recorded warnings",
      detail: `Bound to ${report.artifactHash.slice(0, 12)} by ${report.finalized.actor}.`,
      report,
    }
  }
  if (report.status === "blocked") {
    return {
      kind: "blocked",
      title: "Publication is blocked",
      detail: `${report.summary.blocking} blocking finding${report.summary.blocking === 1 ? "" : "s"} must be resolved or explicitly overridden.`,
      report,
    }
  }
  if (report.status === "warnings") {
    return {
      kind: "warnings",
      title: "Preflight has open warnings",
      detail: `${report.summary.open} non-blocking finding${report.summary.open === 1 ? "" : "s"} remain.`,
      report,
    }
  }
  return {
    kind: "ready",
    title: "Ready to finalize",
    detail: "No open deterministic findings remain for these manuscript bytes.",
    report,
  }
}
