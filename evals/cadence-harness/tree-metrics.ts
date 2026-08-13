import type { CampaignSessionMetrics, CampaignTokenMetrics, CampaignTreeMetrics } from "./report-types"

type Json = Record<string, any>

export type CapturedSessionSource = {
  sessionID?: string
  session?: unknown
  trace?: unknown
  executions?: unknown
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function finite(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function executions(value: unknown) {
  if (Array.isArray(value)) return value
  const source = record(value)
  for (const key of ["executions", "runs", "jobs", "items"]) {
    if (Array.isArray(source?.[key])) return source[key]
  }
  return []
}

function failed(value: unknown) {
  const normalized = String(record(value)?.status ?? record(value)?.outcome ?? "").toLowerCase()
  return ["failure", "failed", "error", "errored", "abort", "aborted"].includes(normalized)
}

function tokenMetrics(value: unknown): CampaignTokenMetrics | undefined {
  const source = record(value)
  if (!source) return undefined
  const input = finite(source.input ?? source.inputTokens ?? source.prompt ?? source.promptTokens)
  const output = finite(source.output ?? source.outputTokens ?? source.completion ?? source.completionTokens)
  const reasoning = finite(source.reasoning ?? source.reasoningTokens)
  const cache = record(source.cache)
  const cacheRead = finite(source.cacheRead ?? source.cacheReadTokens ?? source.cachedInputTokens ?? cache?.read)
  const cacheWrite = finite(source.cacheWrite ?? source.cacheWriteTokens ?? cache?.write)
  const explicit = finite(source.total ?? source.totalTokens)
  const parts = [input, output, reasoning, cacheRead, cacheWrite].filter((item): item is number => item !== undefined)
  if (explicit === undefined && !parts.length) return undefined
  return {
    total: explicit ?? parts.reduce((sum, item) => sum + item, 0),
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
  }
}

function addTokens(target: CampaignTokenMetrics, source: CampaignTokenMetrics | undefined) {
  if (!source) return
  for (const key of ["total", "input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
    if (source[key] !== undefined) target[key] = (target[key] ?? 0) + source[key]!
  }
}

function failureKey(value: unknown) {
  const source = record(value)
  if (!source) return `value:${JSON.stringify(value)}`
  const id = string(source.id ?? source.messageID ?? record(source.error)?.id)
  if (id) return `id:${id}`
  return `content:${JSON.stringify([
    source.kind ?? source.type ?? source.name,
    source.message ?? record(source.error)?.message ?? source.detail ?? source.reason,
    source.createdAt ?? source.at ?? source.time,
  ])}`
}

function uniqueFailureCount(values: unknown[]) {
  return new Set(values.map(failureKey)).size
}

/**
 * Aggregate only captured per-session traces. This deliberately keeps raw,
 * deduplicated trace failures separate from summary-reported failure counts:
 * the latter cannot safely be reconciled when a provider repeats a failure.
 */
export function aggregateCapturedSessionTree(
  sources: CapturedSessionSource[],
  rootSessionID?: string,
): CampaignTreeMetrics | undefined {
  if (!sources.length) return undefined
  const byID = new Map<string, CapturedSessionSource>()
  const warnings: string[] = []
  for (const source of sources) {
    const session = record(source.session)
    const trace = record(source.trace)
    const id = string(source.sessionID ?? session?.id ?? record(trace?.session)?.id)
    if (!id) {
      warnings.push("A captured session had no stable session ID and was omitted.")
      continue
    }
    if (byID.has(id)) {
      warnings.push(`Duplicate captured session ${id} was counted once.`)
      continue
    }
    byID.set(id, source)
  }
  if (!byID.size) return undefined

  const resolvedRoot = rootSessionID && byID.has(rootSessionID) ? rootSessionID : byID.keys().next().value
  const agents = new Map<string, string>()
  for (const source of byID.values()) {
    const trace = record(source.trace)
    for (const child of array(trace?.children)) {
      const item = record(child)
      const sessionID = string(item?.sessionID ?? item?.sessionId ?? item?.id)
      const agent = string(item?.agent)
      if (sessionID && agent) agents.set(sessionID, agent)
    }
  }

  const allFailures: unknown[] = []
  const tokens: CampaignTokenMetrics = { total: 0 }
  let hasTokens = false
  let hasCost = false
  let cost = 0
  let executionSessionCount = 0
  const sessions: CampaignSessionMetrics[] = []
  const expectedChildren = new Set<string>()

  for (const [sessionID, source] of byID) {
    const session = record(source.session)
    const trace = record(source.trace)
    const summary = record(trace?.summary)
    const traceFailures = array(trace?.failures)
    const traceTools = array(trace?.tools)
    const traceSearches = array(trace?.searches)
    const traceApprovals = array(trace?.approvals)
    const traceChildren = array(trace?.children)
    const traceRetries = array(trace?.retries)
    for (const child of traceChildren) {
      const item = record(child)
      const childID = string(item?.sessionID ?? item?.sessionId ?? item?.id)
      if (childID) expectedChildren.add(childID)
    }
    allFailures.push(...traceFailures)

    const usage = tokenMetrics(summary?.tokens)
    if (usage) {
      hasTokens = true
      addTokens(tokens, usage)
    }
    const sessionCost = finite(summary?.cost)
    if (sessionCost !== undefined) {
      hasCost = true
      cost += sessionCost
    }
    const executionValues = executions(source.executions)
    const executionRecord = record(source.executions)
    const executionCaptured = Array.isArray(source.executions) || Boolean(executionRecord && !executionRecord.error)
    if (executionCaptured) executionSessionCount += 1
    const parentSessionId = string(session?.parentID ?? session?.parentId ?? session?.parent_id)
    sessions.push({
      sessionId: sessionID,
      parentSessionId,
      isRoot: sessionID === resolvedRoot,
      title: string(session?.title ?? record(trace?.session)?.title),
      agent: agents.get(sessionID),
      status: string(record(trace?.session)?.status),
      durationMs: finite(summary?.totalCompletionTimeMs ?? summary?.durationMs),
      timeToFirstOutputMs: finite(summary?.timeToFirstUsefulOutputMs ?? summary?.timeToFirstOutputMs),
      toolCalls: Array.isArray(trace?.tools) ? traceTools.length : (finite(summary?.toolCalls) ?? 0),
      searches: Array.isArray(trace?.searches) ? traceSearches.length : (finite(summary?.searchCount) ?? 0),
      approvals: Array.isArray(trace?.approvals) ? traceApprovals.length : (finite(summary?.approvalCount) ?? 0),
      childAgentLinks: Array.isArray(trace?.children) ? traceChildren.length : (finite(summary?.childCount) ?? 0),
      retries: Array.isArray(trace?.retries) ? traceRetries.length : (finite(summary?.retryCount) ?? 0),
      failures: uniqueFailureCount(traceFailures),
      reportedFailures: finite(summary?.failureCount),
      executions: executionValues.length,
      failedExecutions: executionValues.filter(failed).length,
      cost: sessionCost,
      tokens: usage,
    })
    if (!trace) warnings.push(`Session ${sessionID} had no captured trace.`)
    if (source.executions === undefined) warnings.push(`Session ${sessionID} had no captured execution query.`)
    else if (record(source.executions)?.error)
      warnings.push(`Session ${sessionID} execution capture returned an error.`)
  }

  for (const childID of expectedChildren) {
    if (!byID.has(childID)) warnings.push(`Child session ${childID} was referenced but not captured.`)
  }

  sessions.sort((left, right) => {
    if (left.isRoot !== right.isRoot) return left.isRoot ? -1 : 1
    return left.sessionId.localeCompare(right.sessionId)
  })
  const sum = (key: keyof CampaignSessionMetrics) =>
    sessions.reduce((total, session) => total + (typeof session[key] === "number" ? (session[key] as number) : 0), 0)
  const uniqueFailures = uniqueFailureCount(allFailures)
  return {
    source: "captured-session-traces",
    sessionCount: sessions.length,
    childSessionCount: Math.max(0, sessions.length - 1),
    toolCalls: sum("toolCalls"),
    searches: sum("searches"),
    approvals: sum("approvals"),
    childAgentLinks: sum("childAgentLinks"),
    retries: sum("retries"),
    failures: uniqueFailures,
    reportedFailures: sum("reportedFailures"),
    executions: sum("executions"),
    failedExecutions: sum("failedExecutions"),
    executionSessionCount,
    cost: hasCost ? cost : undefined,
    tokens: hasTokens ? tokens : undefined,
    captureComplete: warnings.length === 0,
    sessions,
    warnings,
  }
}
