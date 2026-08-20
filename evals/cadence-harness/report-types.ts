export type JsonRecord = Record<string, unknown>

export type CampaignRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "blocked"
  | "inconclusive"
  | "failed"
  | "cancelled"
  | "unknown"

export type CampaignFileLink = {
  label: string
  href?: string
  path?: string
  kind?: string
  bytes?: number
}

export type CampaignFailure = {
  id?: string
  title: string
  message?: string
  code?: string
  source?: string
  at?: string
}

export type CampaignTimelineEntry = {
  kind: string
  name: string
  status?: string
  at?: string
  durationMs?: number
}

export type CampaignTokenMetrics = {
  total: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

export type CampaignRunMetrics = {
  durationMs?: number
  timeToFirstEventMs?: number
  timeToFirstOutputMs?: number
  cost?: number
  tokens?: CampaignTokenMetrics
  inferenceCalls?: number
  toolCalls?: number
  toolCallsPerInference?: number
  toolExecutionMs?: number
  toolCriticalPathMs?: number
  toolMaxConcurrency?: number
  toolParallelism?: number
  toolContractBytes?: number
  contractBytes?: number
  searches?: number
  childAgents?: number
  retries?: number
  failures: number
  eventCount?: number
  eventBytes?: number
  eventsTruncated?: boolean
}

export type CampaignSessionMetrics = {
  sessionId: string
  parentSessionId?: string
  isRoot: boolean
  title?: string
  agent?: string
  status?: string
  durationMs?: number
  timeToFirstOutputMs?: number
  toolCalls: number
  searches: number
  approvals: number
  childAgentLinks: number
  retries: number
  failures: number
  reportedFailures?: number
  executions: number
  failedExecutions: number
  cost?: number
  tokens?: CampaignTokenMetrics
}

export type CampaignTreeMetrics = {
  source: "captured-session-traces"
  sessionCount: number
  childSessionCount: number
  toolCalls: number
  searches: number
  approvals: number
  childAgentLinks: number
  retries: number
  failures: number
  reportedFailures: number
  executions: number
  failedExecutions: number
  executionSessionCount: number
  cost?: number
  tokens?: CampaignTokenMetrics
  captureComplete: boolean
  sessions: CampaignSessionMetrics[]
  warnings: string[]
}

export type CampaignRunReport = {
  id: string
  promptId: string
  title: string
  batchId?: string
  status: CampaignRunStatus
  projectId?: string
  projectLabel?: string
  sessionId?: string
  model?: string
  provider?: string
  effort?: string
  startedAt?: string
  completedAt?: string
  metrics: CampaignRunMetrics
  treeMetrics?: CampaignTreeMetrics
  prompt?: string
  final?: string
  timeline: CampaignTimelineEntry[]
  failures: CampaignFailure[]
  artifacts: CampaignFileLink[]
  sourceFiles: CampaignFileLink[]
  directory: string
  warnings: string[]
}

export type CampaignImprovement = {
  id: string
  title: string
  status?: string
  area?: string
  batchId?: string
  generalizable?: boolean
  rationale?: string
  evidence?: string[]
  changes?: string[]
  validation?: string[]
  files?: string[]
}

export type CampaignBatchReport = {
  id: string
  title: string
  index?: number
  status: CampaignRunStatus
  startedAt?: string
  completedAt?: string
  runIds: string[]
  analysis?: string
  improvements: CampaignImprovement[]
  sourceFiles: CampaignFileLink[]
  directory: string
  warnings: string[]
}

export type CampaignTotals = {
  planned: number
  observed: number
  completed: number
  running: number
  failed: number
  partial: number
  blocked: number
  inconclusive: number
  cancelled: number
  pending: number
  durationMs: number
  medianDurationMs?: number
  p95DurationMs?: number
  cost: number
  tokens: number
  toolCalls: number
  searches: number
  childAgents: number
  retries: number
  failures: number
  tree?: {
    runs: number
    sessions: number
    childSessions: number
    toolCalls: number
    searches: number
    approvals: number
    retries: number
    failures: number
    reportedFailures: number
    executions: number
    failedExecutions: number
    cost: number
    tokens: number
  }
}

export type CampaignReport = {
  schemaVersion: 1
  id: string
  title: string
  status: CampaignRunStatus
  root: string
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  model?: string
  provider?: string
  effort?: string
  harnessRevision?: string
  sourceLabel?: string
  totals: CampaignTotals
  runs: CampaignRunReport[]
  batches: CampaignBatchReport[]
  improvements: CampaignImprovement[]
  warnings: string[]
  generatedAt: string
}

/**
 * On-disk JSON is deliberately permissive. The campaign runner evolves while
 * batches are in flight, and interrupted writes must still produce a useful
 * dashboard. The renderer narrows these records through a field allowlist.
 */
export type PartialCampaignFile = JsonRecord
export type PartialRunFile = JsonRecord
export type PartialTraceFile = JsonRecord
export type PartialTrajectoryFile = JsonRecord
export type PartialBatchFile = JsonRecord
export type PartialImprovementsFile = JsonRecord | unknown[]

export type RenderCampaignOptions = {
  root: string
  output?: string
  title?: string
  plannedPrompts?: number
  now?: Date
}
