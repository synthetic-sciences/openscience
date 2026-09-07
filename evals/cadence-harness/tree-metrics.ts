import type { CampaignSessionMetrics, CampaignTokenMetrics, CampaignTreeMetrics } from "./report-types"

type Json = Record<string, unknown>

export type CapturedSessionSource = {
  sessionID?: string
  session?: unknown
  trace?: unknown
  children?: unknown
  executions?: unknown
  messages?: unknown
  filesystem?: unknown
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function capturedTrace(value: unknown) {
  const source = record(value)
  return source && !Object.hasOwn(source, "error") && record(source.summary) ? source : undefined
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

/** Retain usable IDs while distinguishing a verified empty list from a failed query. */
export function capturedChildren(value: unknown) {
  if (!Array.isArray(value)) return { ids: [], complete: false }
  const ids = value.flatMap((child: unknown) => {
    const source = record(child)
    const id = string(source?.id ?? source?.sessionID ?? source?.sessionId)
    // IDs become capture directory names; never follow a path from malformed data.
    return id && /^[a-zA-Z0-9_-]+$/.test(id) ? [id] : []
  })
  return { ids: [...new Set(ids)], complete: ids.length === value.length }
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
    const trace = capturedTrace(source.trace)
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
    const trace = capturedTrace(source.trace)
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
    const trace = capturedTrace(source.trace)
    const summary = record(trace?.summary)
    const traceFailures = array(trace?.failures)
    const traceTools = array(trace?.tools)
    const traceSearches = array(trace?.searches)
    const traceApprovals = array(trace?.approvals)
    const traceChildren = array(trace?.children)
    const traceRetries = array(trace?.retries)
    const discovered = capturedChildren(source.children)
    for (const childID of [...discovered.ids, ...capturedChildren(traceChildren).ids]) expectedChildren.add(childID)
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
    const executionCaptured =
      Array.isArray(source.executions) ||
      Boolean(
        executionRecord &&
        !Object.hasOwn(executionRecord, "error") &&
        ["executions", "runs", "jobs", "items"].some((key) => Array.isArray(executionRecord[key])),
      )
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
      toolCalls: trace ? (Array.isArray(trace.tools) ? traceTools.length : finite(summary?.toolCalls)) : undefined,
      searches: trace
        ? Array.isArray(trace.searches)
          ? traceSearches.length
          : finite(summary?.searchCount)
        : undefined,
      approvals: trace
        ? Array.isArray(trace.approvals)
          ? traceApprovals.length
          : finite(summary?.approvalCount)
        : undefined,
      childAgentLinks: trace
        ? Array.isArray(trace.children)
          ? traceChildren.length
          : finite(summary?.childCount)
        : undefined,
      retries: trace ? (Array.isArray(trace.retries) ? traceRetries.length : finite(summary?.retryCount)) : undefined,
      failures: trace && Array.isArray(trace.failures) ? uniqueFailureCount(traceFailures) : undefined,
      reportedFailures: finite(summary?.failureCount),
      executions: executionCaptured ? executionValues.length : undefined,
      failedExecutions: executionCaptured ? executionValues.filter(failed).length : undefined,
      cost: sessionCost,
      tokens: usage,
    })
    if (!trace)
      warnings.push(
        `Session ${sessionID} trace capture was missing, invalid, or returned an error; its trace metrics are unavailable.`,
      )
    if (!executionCaptured)
      warnings.push(`Session ${sessionID} execution capture was missing, invalid, or returned an error.`)
    if (!discovered.complete)
      warnings.push(`Session ${sessionID} child discovery was missing, invalid, or returned an error.`)
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
