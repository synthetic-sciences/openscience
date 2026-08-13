import type { SessionTraceResponse } from "@synsci/sdk/v2/client"

export type TraceActivity = {
  id: string
  at: number
  kind:
    | "model"
    | "tool"
    | "child"
    | "search"
    | "kernel"
    | "job"
    | "approval"
    | "artifact"
    | "review"
    | "failure"
    | "retry"
  label: string
  detail: string
  status?: string
}

export type ObservableResearchActivity = {
  id: string
  at: number
  kind: "agent" | "search" | "source" | "shell"
  label: string
  detail: string
  status: "pending" | "running" | "completed" | "partial" | "error"
}

export type ObservableKernelActivity = {
  id: string
  at: number
  language: "Python" | "R"
  label: string
  detail: string
  status: "pending" | "running" | "completed" | "error"
}

const childLabel = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (normalized === "explore") return "Exploration task"
  if (normalized === "execute") return "Execution task"
  if (normalized === "review") return "Review task"
  return "Research task"
}

const childDetail = (item: SessionTraceResponse["children"][number]) => {
  const actions = item.toolCalls
  const failed = item.failedToolCalls ?? 0
  // The backend can report bounded child work as `partial`. Keep this
  // compatibility cast until the generated SDK is refreshed from OpenAPI.
  const status = item.status as ObservableResearchActivity["status"]
  const result =
    status === "completed"
      ? actions === undefined
        ? "Completed"
        : `${actions} ${actions === 1 ? "action" : "actions"} completed`
      : status === "partial"
        ? actions === undefined
          ? "Partial result"
          : `${actions} ${actions === 1 ? "action" : "actions"} before the limit`
        : status === "error"
          ? failed > 0
            ? `${failed} ${failed === 1 ? "action needs" : "actions need"} attention`
            : "Task stopped before completing"
          : status === "running"
            ? actions === undefined
              ? "Working"
              : `${actions} ${actions === 1 ? "action" : "actions"} so far`
            : "Waiting to start"
  return [result, formatDuration(item.durationMs)].filter((value) => value !== "—").join(" · ")
}

const searchLabel = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (normalized === "codesearch") return "Code search"
  if (normalized === "science_search") return "Scientific search"
  if (normalized.startsWith("query_")) return "Scientific database search"
  if (normalized === "atlas") return "Research library search"
  return "Web search"
}

const sourceLabelForTool = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (normalized === "science_fetch") return "Scientific source"
  if (normalized === "atlas") return "Research library"
  if (normalized.includes("browser") || normalized.startsWith("browse")) return "Browser"
  return "Web source"
}

const browserTool = (value: string) => {
  const normalized = value.trim().toLowerCase()
  return normalized.includes("browser") || normalized.startsWith("browse")
}

/**
 * A compact, user-readable projection for the Activity pane.
 *
 * Python/R executions, live shell commands, remote jobs, model calls, and
 * generic tools have dedicated surfaces. This projection also retains
 * completed shell commands after their live registry entry disappears, while
 * staying narrow enough to avoid double-counting other work.
 */
export function recentObservableResearch(trace: SessionTraceResponse, limit = 10): ObservableResearchActivity[] {
  const children: ObservableResearchActivity[] = trace.children.map((item) => ({
    id: `child:${item.toolID}`,
    at: item.startedAt ?? trace.session.updatedAt,
    kind: "agent",
    label: childLabel(item.agent),
    detail: childDetail(item),
    status: item.status as ObservableResearchActivity["status"],
  }))

  const searches: ObservableResearchActivity[] = trace.searches.map((item) => ({
    id: `search:${item.toolID}`,
    at: item.startedAt ?? trace.session.updatedAt,
    kind: "search",
    label: item.query?.trim() || searchLabel(item.tool),
    detail: [
      searchLabel(item.tool),
      item.dedupeHit ? "Reused an existing result" : "New result",
      formatDuration(item.durationMs),
    ]
      .filter((value) => value !== "—")
      .join(" · "),
    status: item.status,
  }))

  const searchIDs = new Set(trace.searches.map((item) => item.toolID))
  const sources: ObservableResearchActivity[] = trace.tools
    .filter((item) => !searchIDs.has(item.id) && (item.category === "external" || browserTool(item.name)))
    .map((item) => ({
      id: `source:${item.id}`,
      at: item.startedAt ?? trace.session.updatedAt,
      kind: "source",
      label: item.title?.trim() || sourceLabelForTool(item.name),
      detail: [sourceLabelForTool(item.name), formatDuration(item.durationMs)]
        .filter((value) => value !== "—")
        .join(" · "),
      status: item.status,
    }))

  const shell: ObservableResearchActivity[] = trace.tools
    // Live shell work is already represented by the authoritative command registry.
    // Retain only finished trace activity here so the same process cannot appear twice.
    .filter((item) => item.name === "bash" && (item.status === "completed" || item.status === "error"))
    .map((item) => ({
      id: `shell:${item.id}`,
      at: item.startedAt ?? trace.session.updatedAt,
      kind: "shell",
      label: item.title?.trim() || "Shell command",
      detail: ["Local shell", formatDuration(item.durationMs)].filter((value) => value !== "—").join(" · "),
      status: item.status,
    }))

  return [...children, ...searches, ...sources, ...shell].toSorted((a, b) => b.at - a.at).slice(0, Math.max(0, limit))
}

/**
 * Display-only compatibility history for backends without durable execution
 * records. It is deliberately sourced from the trace's canonical kernel
 * collection, never generic tools, so this cannot invent provenance, files,
 * or arbitrary activity. Any real execution history wins completely.
 */
export function fallbackObservableKernels(
  trace: SessionTraceResponse,
  durableExecutionCount: number,
  limit = 12,
): ObservableKernelActivity[] {
  if (durableExecutionCount > 0) return []

  const tools = new Map(trace.tools.map((item) => [item.id, item]))
  return trace.kernels
    .flatMap((item) => {
      const normalized = item.language.trim().toLowerCase()
      const language = normalized === "python" ? "Python" : normalized === "r" ? "R" : undefined
      if (!language) return []
      const tool = tools.get(item.toolID)
      const action = tool?.title?.trim()
      if (/^stopped\s/i.test(action ?? "")) return []
      const status =
        item.status === "pending" || item.status === "running" || item.status === "completed" || item.status === "error"
          ? item.status
          : "error"
      return [
        {
          id: `trace-kernel:${item.toolID}`,
          at: item.startedAt ?? trace.session.updatedAt,
          language,
          label: action || `${language} execution`,
          detail: [`${language} runtime`, formatDuration(item.durationMs)].filter((value) => value !== "—").join(" · "),
          status,
        } satisfies ObservableKernelActivity,
      ]
    })
    .toSorted((a, b) => b.at - a.at)
    .slice(0, Math.max(0, limit))
}

export function formatDuration(value?: number) {
  if (value === undefined) return "—"
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
  return `${Math.floor(value / 3_600_000)}h ${Math.round((value % 3_600_000) / 60_000)}m`
}

export function formatCost(value: number) {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  })
}

export function formatTokens(value: number) {
  if (value < 1_000) return value.toLocaleString()
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

export function formatClock(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function sourceLabel(value: SessionTraceResponse["inference"][number]["source"]) {
  if (value === "byok") return "API key"
  if (value === "chatgpt") return "ChatGPT"
  if (value === "oauth") return "OAuth"
  return value
}

function usage(trace: SessionTraceResponse) {
  const tokens = trace.summary.tokens
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function traceMetrics(trace: SessionTraceResponse) {
  return [
    {
      label: "first output",
      value: formatDuration(trace.summary.timeToFirstUsefulOutputMs),
      detail: trace.summary.firstUsefulOutputAt ? formatClock(trace.summary.firstUsefulOutputAt) : "not recorded",
    },
    {
      label: "total time",
      value: formatDuration(trace.summary.totalCompletionTimeMs),
      detail: trace.session.status,
    },
    {
      label: "model cost",
      value: formatCost(trace.summary.cost),
      detail: `${formatTokens(usage(trace))} tokens`,
    },
  ]
}

export function traceCounts(trace: SessionTraceResponse) {
  return [
    { label: "tools", value: trace.summary.toolCalls },
    { label: "children", value: trace.summary.childCount },
    { label: "searches", value: trace.summary.searchCount, note: `${trace.summary.dedupeHits} reused` },
    { label: "approvals", value: trace.summary.approvalCount },
    { label: "artifacts", value: trace.summary.artifactSaves },
    { label: "findings", value: trace.summary.reviewerFindings },
    { label: "failures", value: trace.summary.failureCount },
    { label: "retries", value: trace.summary.retryCount },
  ]
}

export function traceActivity(trace: SessionTraceResponse): TraceActivity[] {
  const inference = trace.inference.map((item) => ({
    id: `model:${item.messageID}`,
    at: item.startedAt,
    kind: "model" as const,
    label: `${item.provider} / ${item.model}`,
    detail: `${sourceLabel(item.source)} · ${item.effort} effort · ${formatDuration(item.durationMs)} · ${formatCost(item.cost)}`,
    status: item.completedAt ? "completed" : "running",
  }))
  const tools = trace.tools
    .filter((item) => item.category === "tool" || item.category === "external")
    .map((item) => ({
      id: `tool:${item.id}`,
      at: item.startedAt ?? trace.session.createdAt,
      kind: "tool" as const,
      label: item.title || item.name,
      detail: `${item.name} · ${formatDuration(item.durationMs)}`,
      status: item.status,
    }))
  const children = trace.children.map((item) => ({
    id: `child:${item.toolID}`,
    at: item.startedAt ?? trace.session.createdAt,
    kind: "child" as const,
    label: `${item.agent} child`,
    detail: [
      item.model ? `${item.model.providerID}/${item.model.modelID}` : undefined,
      `${item.toolCalls ?? 0} tools`,
      `${item.failedToolCalls ?? 0} failed`,
      formatDuration(item.durationMs),
    ]
      .filter(Boolean)
      .join(" · "),
    status: item.status,
  }))
  const searches = trace.searches.map((item) => ({
    id: `search:${item.toolID}`,
    at: item.startedAt ?? trace.session.createdAt,
    kind: "search" as const,
    label: item.query || item.tool,
    detail: `${item.tool} · ${item.dedupeHit ? "reused local result" : "new request"} · ${formatDuration(item.durationMs)}`,
    status: item.status,
  }))
  const kernels = trace.kernels.map((item) => ({
    id: `kernel:${item.toolID}`,
    at: item.startedAt ?? trace.session.createdAt,
    kind: "kernel" as const,
    label: `${item.language.toUpperCase()} kernel`,
    detail: `${item.executionCount ?? 0} executions · ${formatDuration(item.durationMs)}`,
    status: item.status,
  }))
  const jobs = trace.jobs.map((item) => ({
    id: `job:${item.id}`,
    at: Date.parse(item.createdAt),
    kind: "job" as const,
    label: item.name,
    detail: `${item.targetLabel} · ${item.artifactCount} artifacts · ${formatDuration(item.durationMs)}`,
    status: item.status,
  }))
  const approvals = trace.approvals.map((item) => ({
    id: `approval:${item.id}`,
    at: item.requestedAt,
    kind: "approval" as const,
    label: item.permission,
    detail: item.reply ? `approved: ${item.reply}` : "waiting for reply",
    status: item.reply === "reject" ? "error" : item.reply ? "completed" : "pending",
  }))
  const artifacts = trace.artifacts.map((item) => ({
    id: `artifact:${item.toolID}`,
    at: item.completedAt ?? trace.session.updatedAt,
    kind: "artifact" as const,
    label: item.artifactID || "Saved Result",
    detail: `${item.action} · ${item.durable ? "durable" : "session only"}`,
    status: "completed",
  }))
  const findings = trace.reviewerFindings.map((item) => ({
    id: `review:${item.toolID}:${item.id ?? item.completedAt ?? "finding"}`,
    at: item.completedAt ?? trace.session.updatedAt,
    kind: "review" as const,
    label: item.issue || item.claim || "Reviewer finding",
    detail: [item.severity, item.relation, item.target].filter(Boolean).join(" · ") || "reviewed",
    status: item.severity === "blocking" || item.severity === "major" ? "error" : "completed",
  }))
  const failures = trace.failures.map((item) => ({
    id: `failure:${item.kind}:${item.id}`,
    at: item.createdAt,
    kind: "failure" as const,
    label: `${item.kind} failure`,
    detail: item.message,
    status: "error",
  }))
  const retries = trace.retries.map((item) => ({
    id: `retry:${item.id}`,
    at: item.createdAt,
    kind: "retry" as const,
    label: `Model retry ${item.attempt}`,
    detail: `${item.message} · next attempt in ${formatDuration(item.delayMs)}`,
    status: "running",
  }))
  return [
    ...inference,
    ...tools,
    ...children,
    ...searches,
    ...kernels,
    ...jobs,
    ...approvals,
    ...artifacts,
    ...findings,
    ...failures,
    ...retries,
  ].toSorted((a, b) => a.at - b.at)
}
