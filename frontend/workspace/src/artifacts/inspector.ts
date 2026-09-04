import type { ArtifactContext } from "./context"

export const inspectorTabs = ["details", "code", "run", "messages", "environment", "review", "history"] as const
export type InspectorTab = (typeof inspectorTabs)[number]

export interface ArtifactCommit {
  sha: string
  author: string
  email: string
  date: string
  message: string
}

export interface ArtifactProvenance {
  path: string
  tracked: boolean
  dirty: boolean
  status: "clean" | "modified" | "added" | "deleted" | "untracked" | "local"
  branch?: string
  commit?: ArtifactCommit
}

export interface InspectorState {
  available: boolean
  title: string
  detail: string
}

export interface LineageRun {
  id: string
  tool: string
  label: string
  status?: "ok" | "error"
  recordedAt: string
  sessionID?: string
  messageID?: string
  callID?: string
  code?: string
  command?: string
  cwd?: string
  kernel?: { language?: string; name?: string }
  startedAt?: string
  completedAt?: string
}

export interface LineageMessage {
  sessionID: string
  messageID: string
}

export interface InspectorData {
  context: ArtifactContext
  source?: string
  provenance?: ArtifactProvenance
  environments: string[]
  lockfiles: string[]
  runs: LineageRun[]
  messages: LineageMessage[]
  tabs: Record<InspectorTab, InspectorState>
}

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

// ── Historical review records (provenance graph) ────────────────────────────
//
// Earlier OpenScience versions wrote review records into the project provenance
// graph. The current API exposes them through GET /provenance/reviews only; the
// deterministic publication preflight above remains the active workflow.

export type HistoricalReviewVerdict = "refutes" | "supports"
export type HistoricalReviewStatus = "open" | "addressed" | "confirmed"

export interface HistoricalReviewFinding {
  id: string
  target: string
  verdict: HistoricalReviewVerdict
  status?: HistoricalReviewStatus
  severity: PublicationReviewSeverity
  claim: string
  issue: string
  evidence: string
  recordedBy: string
  sessionID?: string
  recordedAt: string
  resolution?: { actor: string; reason: string; recordedAt: string }
}

export function normalizeHistoricalReviews(value: unknown): HistoricalReviewFinding[] {
  if (!Array.isArray(value)) return []
  const severities = new Set(["blocking", "major", "minor", "info"])
  const statuses = new Set(["open", "addressed", "confirmed"])
  return value
    .flatMap((item): HistoricalReviewFinding[] => {
      const row = record(item)
      const finding = record(row?.finding)
      const meta = record(finding?.meta)
      if (
        !row ||
        !finding ||
        !meta ||
        typeof finding.id !== "string" ||
        typeof finding.recordedAt !== "string" ||
        typeof row.target !== "string" ||
        (row.verdict !== "refutes" && row.verdict !== "supports") ||
        typeof meta.claim !== "string" ||
        typeof meta.issue !== "string" ||
        typeof meta.severity !== "string" ||
        !severities.has(meta.severity) ||
        typeof meta.evidence !== "string"
      )
        return []
      const status = typeof row.status === "string" && statuses.has(row.status) ? row.status : undefined
      const resolution = record(row.resolution)
      const parsed =
        resolution &&
        typeof resolution.actor === "string" &&
        typeof resolution.reason === "string" &&
        typeof resolution.recordedAt === "string"
          ? { actor: resolution.actor, reason: resolution.reason, recordedAt: resolution.recordedAt }
          : undefined
      return [
        {
          id: finding.id,
          target: row.target,
          verdict: row.verdict,
          ...(status ? { status: status as HistoricalReviewStatus } : {}),
          severity: meta.severity as PublicationReviewSeverity,
          claim: meta.claim,
          issue: meta.issue,
          evidence: meta.evidence,
          recordedBy: typeof meta.reviewer === "string" ? meta.reviewer : "Earlier OpenScience version",
          ...(typeof meta.sessionID === "string" ? { sessionID: meta.sessionID } : {}),
          recordedAt: finding.recordedAt,
          ...(parsed ? { resolution: parsed } : {}),
        },
      ]
    })
    .toSorted((a, b) => b.recordedAt.localeCompare(a.recordedAt))
}

/**
 * Findings cannot be reliably related to a single artifact (the target is a
 * provenance node id, not a path), so the surface scopes honestly: the current
 * session's findings when a session is open, the whole project otherwise.
 */
export function filterHistoricalReviews(
  rows: HistoricalReviewFinding[],
  sessionID?: string,
): HistoricalReviewFinding[] {
  if (!sessionID) return rows
  return rows.filter((row) => row.sessionID === sessionID)
}

interface InspectorInput {
  file?: unknown
  provenance?: unknown
  audit?: unknown
  lineage?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return []
  return value
}

function commit(value: unknown): ArtifactCommit | undefined {
  const row = record(value)
  if (!row) return
  if (
    typeof row.sha !== "string" ||
    typeof row.author !== "string" ||
    typeof row.email !== "string" ||
    typeof row.date !== "string" ||
    typeof row.message !== "string"
  )
    return
  return {
    sha: row.sha,
    author: row.author,
    email: row.email,
    date: row.date,
    message: row.message,
  }
}

function provenance(value: unknown): ArtifactProvenance | undefined {
  const row = record(value)
  if (!row) return
  const statuses = new Set(["clean", "modified", "added", "deleted", "untracked", "local"])
  if (
    typeof row.path !== "string" ||
    typeof row.tracked !== "boolean" ||
    typeof row.dirty !== "boolean" ||
    typeof row.status !== "string" ||
    !statuses.has(row.status)
  )
    return
  const version = row.commit === undefined ? undefined : commit(row.commit)
  if (row.commit !== undefined && !version) return
  return {
    path: row.path,
    tracked: row.tracked,
    dirty: row.dirty,
    status: row.status as ArtifactProvenance["status"],
    ...(typeof row.branch === "string" ? { branch: row.branch } : {}),
    ...(version ? { commit: version } : {}),
  }
}

function source(value: unknown): string | undefined {
  const row = record(value)
  if (!row || row.encoding === "base64" || typeof row.content !== "string") return
  return row.content
}

function lineageRun(value: unknown): LineageRun | undefined {
  const row = record(value)
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.tool !== "string" ||
    typeof row.label !== "string" ||
    typeof row.recordedAt !== "string"
  )
    return
  const kernel = record(row.kernel)
  const language = kernel && typeof kernel.language === "string" ? kernel.language : undefined
  const name = kernel && typeof kernel.name === "string" ? kernel.name : undefined
  return {
    id: row.id,
    tool: row.tool,
    label: row.label,
    ...(row.status === "ok" || row.status === "error" ? { status: row.status } : {}),
    recordedAt: row.recordedAt,
    ...(typeof row.sessionID === "string" ? { sessionID: row.sessionID } : {}),
    ...(typeof row.messageID === "string" ? { messageID: row.messageID } : {}),
    ...(typeof row.callID === "string" ? { callID: row.callID } : {}),
    ...(typeof row.code === "string" ? { code: row.code } : {}),
    ...(typeof row.command === "string" ? { command: row.command } : {}),
    ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
    ...(language !== undefined || name !== undefined
      ? { kernel: { ...(language !== undefined ? { language } : {}), ...(name !== undefined ? { name } : {}) } }
      : {}),
    ...(typeof row.startedAt === "string" ? { startedAt: row.startedAt } : {}),
    ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
  }
}

function lineageMessage(value: unknown): LineageMessage | undefined {
  const row = record(value)
  if (!row || typeof row.sessionID !== "string" || typeof row.messageID !== "string") return
  return { sessionID: row.sessionID, messageID: row.messageID }
}

function lineage(value: unknown): { runs: LineageRun[]; messages: LineageMessage[] } {
  const row = record(value)
  const runs = Array.isArray(row?.runs)
    ? row.runs.flatMap((item) => {
        const parsed = lineageRun(item)
        return parsed ? [parsed] : []
      })
    : []
  const messages = Array.isArray(row?.messages)
    ? row.messages.flatMap((item) => {
        const parsed = lineageMessage(item)
        return parsed ? [parsed] : []
      })
    : []
  return { runs, messages }
}

function state(available: boolean, title: string, detail: string): InspectorState {
  return { available, title, detail }
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

export function normalizeInspectorData(context: ArtifactContext, input: InspectorInput): InspectorData {
  const text = source(input.file)
  const version = provenance(input.provenance)
  const audit = record(input.audit)
  const environments = strings(audit?.environments)
  const lockfiles = strings(audit?.lockfiles)
  const environment = environments.length > 0 || lockfiles.length > 0
  const trace = lineage(input.lineage)
  return {
    context,
    ...(text !== undefined ? { source: text } : {}),
    ...(version ? { provenance: version } : {}),
    environments,
    lockfiles,
    runs: trace.runs,
    messages: trace.messages,
    tabs: {
      details: state(true, "Artifact details", "Format, location, and recorded scientific metadata."),
      code:
        text !== undefined
          ? state(true, "Source available", "The original text source is available for inspection.")
          : state(false, "Source is not directly displayable", "Open the file view or download the original artifact."),
      run:
        trace.runs.length > 0
          ? state(
              true,
              "Producing run recorded",
              `${trace.runs.length} recorded run${trace.runs.length === 1 ? "" : "s"} produced this artifact.`,
            )
          : state(false, "No generating run is recorded", "Execute or attach a run to connect logs and resources."),
      messages:
        trace.messages.length > 0
          ? state(
              true,
              "Producing messages recorded",
              `${trace.messages.length} conversation message${trace.messages.length === 1 ? "" : "s"} produced this artifact.`,
            )
          : state(
              false,
              "No message range is recorded",
              "Artifacts created from a conversation will show the exact producing messages here.",
            ),
      environment: environment
        ? state(true, "Environment records found", "Project environment specifications and lockfiles are available.")
        : state(false, "No environment is recorded", "Add a lockfile or environment specification to this project."),
      review: state(true, "Artifact review", "Durable annotations and review threads are available for this artifact."),
      history: version?.commit
        ? state(true, "Git provenance available", "The latest commit touching this artifact is recorded.")
        : state(false, "No Git commit is recorded", "Commit this artifact to create a recoverable version."),
    },
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
