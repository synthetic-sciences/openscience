import path from "node:path"
import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type {
  CampaignBatchReport,
  CampaignFailure,
  CampaignFileLink,
  CampaignImprovement,
  CampaignReport,
  CampaignRunMetrics,
  CampaignRunReport,
  CampaignRunStatus,
  CampaignTimelineEntry,
  CampaignTreeMetrics,
  JsonRecord,
  PartialBatchFile,
  PartialCampaignFile,
  PartialImprovementsFile,
  PartialRunFile,
  PartialTraceFile,
  PartialTrajectoryFile,
  RenderCampaignOptions,
} from "./report-types"
import { aggregateCapturedSessionTree, type CapturedSessionSource } from "./tree-metrics"

const moduleDirectory = fileURLToPath(new URL(".", import.meta.url))
const DEFAULT_PLANNED_PROMPTS = 20
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MAX_TIMELINE_ENTRIES = 1_000
const MAX_ARTIFACTS = 250
const ignoredDirectories = new Set([".git", "node_modules", "dashboard"])

type ReadWarnings = string[]

type EventSummary = {
  count: number
  bytes: number
  truncated: boolean
  timeline: CampaignTimelineEntry[]
  failures: CampaignFailure[]
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const record = (value: unknown) => (isRecord(value) ? value : undefined)

function nested(value: unknown, key: string): unknown {
  let current = value
  for (const part of key.split(".")) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function first(value: unknown, keys: string[]): unknown {
  for (const key of keys) {
    const candidate = nested(value, key)
    if (candidate !== undefined && candidate !== null && candidate !== "") return candidate
  }
}

function text(value: unknown, keys: string[], maximum = 2_000) {
  const candidate = first(value, keys)
  if (typeof candidate !== "string" && typeof candidate !== "number") return undefined
  return scrubText(String(candidate), maximum)
}

function numberValue(value: unknown, keys: string[]) {
  const candidate = first(value, keys)
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
  if (typeof candidate === "string" && candidate.trim() !== "") {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed)) return parsed
  }
}

function booleanValue(value: unknown, keys: string[]) {
  const candidate = first(value, keys)
  if (typeof candidate === "boolean") return candidate
  if (candidate === "true") return true
  if (candidate === "false") return false
}

function arrayValue(value: unknown, keys: string[]) {
  const candidate = first(value, keys)
  return Array.isArray(candidate) ? candidate : []
}

function stringArray(value: unknown, keys: string[]) {
  const candidate = first(value, keys)
  if (typeof candidate === "string") return [scrubText(candidate, 1_000)]
  if (!Array.isArray(candidate)) return []
  return candidate.flatMap((item) => {
    if (typeof item === "string" || typeof item === "number") return [scrubText(String(item), 1_000)]
    if (!isRecord(item)) return []
    const label = text(item, ["title", "label", "name", "id", "path"], 1_000)
    return label ? [label] : []
  })
}

function scrubText(value: string, maximum = 20_000) {
  const scrubbed = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [redacted]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|thk)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted-token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted-google-key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi, "$1[redacted]$2")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\b(["']?\s*[:=]\s*["']?)([^\s,;"']+)/gi,
      "$1$2[redacted]",
    )
  if (scrubbed.length <= maximum) return scrubbed
  return `${scrubbed.slice(0, maximum)}\n\n[Content truncated in dashboard; see the saved deliverable.]`
}

function isoDate(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined
  const raw = typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value
  const parsed = new Date(raw as string | number)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function status(value: unknown): CampaignRunStatus {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
  if (["success", "succeeded", "complete", "completed", "done", "idle"].includes(normalized)) return "completed"
  if (
    [
      "running",
      "active",
      "busy",
      "in_progress",
      "in-progress",
      "in progress",
      "started",
      "retry",
      "compacting",
    ].includes(normalized)
  )
    return "running"
  if (["failure", "failed", "error", "errored", "abort", "aborted"].includes(normalized)) return "failed"
  if (normalized === "partial") return "partial"
  if (["blocked", "blocked_policy", "policy_blocked"].includes(normalized)) return "blocked"
  if (normalized === "inconclusive") return "inconclusive"
  if (["cancelled", "canceled", "interrupted", "stopped"].includes(normalized)) return "cancelled"
  if (["queued", "pending", "planned", "not_started", "not-started"].includes(normalized)) return "pending"
  return "unknown"
}

function cleanID(value: string | undefined, fallback: string) {
  const normalized = value?.trim()
  return normalized ? scrubText(normalized, 160) : fallback
}

function naturalNumber(value: string) {
  const match = value.match(/\d+/)
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER
}

function sortNatural<T>(items: T[], label: (item: T) => string) {
  return items.sort((left, right) => {
    const leftLabel = label(left)
    const rightLabel = label(right)
    const numberDifference = naturalNumber(leftLabel) - naturalNumber(rightLabel)
    return numberDifference || leftLabel.localeCompare(rightLabel, undefined, { numeric: true })
  })
}

function relativeLabel(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith("..") ? relative : path.basename(file)
}

async function readJson<T>(file: string, warnings: ReadWarnings, root: string): Promise<T | undefined> {
  if (!(await Bun.file(file).exists())) return undefined
  try {
    return (await Bun.file(file).json()) as T
  } catch {
    warnings.push(`${relativeLabel(root, file)} is not valid JSON`)
  }
}

async function readText(file: string, warnings: ReadWarnings, root: string, maximum = MAX_TEXT_BYTES) {
  const source = Bun.file(file)
  if (!(await source.exists())) return undefined
  try {
    const truncated = source.size > maximum
    const value = await source.slice(0, maximum).text()
    if (truncated) warnings.push(`${relativeLabel(root, file)} was truncated in the dashboard`)
    return scrubText(value, maximum)
  } catch {
    warnings.push(`${relativeLabel(root, file)} could not be read`)
  }
}

async function findNamedFiles(root: string, target: string, maximumDepth = 8) {
  const matches: string[] = []
  let visited = 0
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maximumDepth || visited > 15_000) return
    visited += 1
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name)
        if (entry.isFile() && entry.name === target) {
          matches.push(file)
          return
        }
        if (!entry.isDirectory() || ignoredDirectories.has(entry.name) || entry.name.startsWith(".")) return
        if (entry.name === "artifacts" || entry.name === "workspace") return
        await visit(file, depth + 1)
      }),
    )
  }
  await visit(root, 0)
  return matches.sort()
}

function tokenMetrics(
  run: PartialRunFile,
  trace: PartialTraceFile | undefined,
  trajectory: PartialTrajectoryFile | undefined,
) {
  const sources = [
    first(run, ["tokens", "usage.tokens", "metrics.tokens", "summary.tokens"]),
    first(trace, ["summary.tokens", "tokens", "usage.tokens"]),
    first(trajectory, ["summary.tokens", "tokens", "usage.tokens", "metadata.tokens"]),
  ]
  const source = sources.find(isRecord)
  if (!source || !isRecord(source)) return undefined
  const input = numberValue(source, ["input", "inputTokens", "prompt", "promptTokens"])
  const output = numberValue(source, ["output", "outputTokens", "completion", "completionTokens"])
  const reasoning = numberValue(source, ["reasoning", "reasoningTokens"])
  const cacheRead = numberValue(source, ["cache.read", "cacheRead", "cacheReadTokens", "cachedInputTokens"])
  const cacheWrite = numberValue(source, ["cache.write", "cacheWrite", "cacheWriteTokens"])
  const explicit = numberValue(source, ["total", "totalTokens"])
  const parts = [input, output, reasoning, cacheRead, cacheWrite].filter((item): item is number => item !== undefined)
  if (explicit === undefined && parts.length === 0) return undefined
  return {
    total: explicit ?? parts.reduce((sum, item) => sum + item, 0),
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
  }
}

function normalizedFailure(value: unknown, source: string): CampaignFailure | undefined {
  if (typeof value === "string") return { title: "Failure", message: scrubText(value, 600), source }
  if (!isRecord(value)) return undefined
  const id = text(value, ["id", "messageID", "error.id"], 180)
  const title = text(value, ["title", "name", "error.name", "type"], 180) ?? "Failure"
  const message = text(value, ["message", "error.message", "detail", "reason"], 600)
  const code = text(value, ["code", "error.code", "statusCode"], 120)
  const at = isoDate(first(value, ["at", "time", "timestamp", "createdAt", "startedAt"]))
  return { id, title, message, code, source, at }
}

function collectFailures(run: PartialRunFile, trace: PartialTraceFile | undefined) {
  const failures: CampaignFailure[] = []
  const add = (items: unknown[], source: string) => {
    for (const item of items) {
      const failure = normalizedFailure(item, source)
      if (failure) failures.push(failure)
    }
  }
  const recorded = first(run, ["failures", "errors"])
  if (Array.isArray(recorded)) add(recorded, "run")
  else add(arrayValue(trace, ["failures", "errors"]), "trace")
  const seenIDs = new Set<string>()
  const seenContent = new Set<string>()
  return failures.filter((failure) => {
    const content = `${failure.title}|${failure.message ?? ""}|${failure.code ?? ""}|${failure.at ?? ""}`
    if ((failure.id && seenIDs.has(failure.id)) || seenContent.has(content)) return false
    if (failure.id) seenIDs.add(failure.id)
    seenContent.add(content)
    return true
  })
}

function timelineEntry(value: unknown, fallbackKind?: string): CampaignTimelineEntry | undefined {
  if (!isRecord(value)) return undefined
  const name = text(value, ["name", "title", "tool", "action", "event", "type", "kind"], 220)
  if (!name) return undefined
  const kind = text(value, ["kind", "category", "type"], 80) ?? fallbackKind ?? "event"
  const entryStatus = text(value, ["status", "outcome", "state"], 60)
  const at = isoDate(first(value, ["at", "time", "timestamp", "startedAt", "createdAt"]))
  const started = first(value, ["startedAt", "start", "startTime"])
  const completed = first(value, ["completedAt", "endedAt", "end", "endTime"])
  const explicitDuration = numberValue(value, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"])
  const startedDate = isoDate(started)
  const completedDate = isoDate(completed)
  const durationMs =
    explicitDuration ??
    (startedDate && completedDate
      ? Math.max(0, new Date(completedDate).getTime() - new Date(startedDate).getTime())
      : undefined)
  return { kind, name, status: entryStatus, at, durationMs }
}

function collectTimeline(
  trace: PartialTraceFile | undefined,
  trajectory: PartialTrajectoryFile | undefined,
  executions: unknown,
  events: EventSummary,
) {
  const timeline: CampaignTimelineEntry[] = []
  const append = (items: unknown[], fallbackKind?: string) => {
    for (const item of items) {
      const entry = timelineEntry(item, fallbackKind)
      if (entry) timeline.push(entry)
    }
  }
  append(arrayValue(trajectory, ["timeline", "events", "steps", "trajectory"]), "trajectory")
  append(arrayValue(trace, ["tools"]), "tool")
  append(arrayValue(trace, ["children"]), "agent")
  append(arrayValue(trace, ["searches"]), "search")
  append(arrayValue(trace, ["kernels"]), "kernel")
  append(arrayValue(trace, ["jobs"]), "job")
  const executionList = Array.isArray(executions)
    ? executions
    : arrayValue(executions, ["executions", "runs", "jobs", "items"])
  append(executionList, "execution")
  append(events.timeline, "event")
  const seen = new Set<string>()
  return timeline
    .filter((entry) => {
      const key = `${entry.kind}|${entry.name}|${entry.status ?? ""}|${entry.at ?? ""}|${entry.durationMs ?? ""}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_TIMELINE_ENTRIES)
}

async function summarizeEvents(file: string): Promise<EventSummary> {
  const source = Bun.file(file)
  if (!(await source.exists())) return { count: 0, bytes: 0, truncated: false, timeline: [], failures: [] }
  const truncated = source.size > MAX_EVENT_BYTES
  const raw = await source
    .slice(0, MAX_EVENT_BYTES)
    .text()
    .catch(() => "")
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const timeline: CampaignTimelineEntry[] = []
  const failures: CampaignFailure[] = []
  for (const line of lines) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    const eventName = text(event, ["type", "event", "name", "kind"], 160)
    if (!eventName) continue
    const eventStatus = text(event, ["status", "outcome", "state"], 60)
    if (/error|fail/i.test(eventName) || status(eventStatus) === "failed") {
      const failure = normalizedFailure(event, "event")
      if (failure) failures.push(failure)
    }
    if (!/(tool|session|run|task|kernel|job|search|artifact|error|fail|retry|agent|message.*complete)/i.test(eventName))
      continue
    if (/delta|partial|chunk/i.test(eventName)) continue
    const entry = timelineEntry(event, "event")
    if (entry) timeline.push(entry)
  }
  return {
    count: lines.length,
    bytes: source.size,
    truncated,
    timeline: timeline.slice(0, MAX_TIMELINE_ENTRIES),
    failures,
  }
}

async function capturedTreeMetrics(
  runDirectory: string,
  rootSessionID: string | undefined,
  rootExecutions: unknown,
  warnings: ReadWarnings,
  campaignRoot: string,
): Promise<CampaignTreeMetrics | undefined> {
  const rawRoot = path.join(runDirectory, "raw", "sessions")
  const entries = await readdir(rawRoot, { withFileTypes: true }).catch(() => [])
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  if (!directories.length) return undefined
  const sources = await Promise.all(
    directories.map(async (entry): Promise<CapturedSessionSource> => {
      const directory = path.join(rawRoot, entry.name)
      const [session, trace, capturedExecutions] = await Promise.all([
        readJson<unknown>(path.join(directory, "session.json"), warnings, campaignRoot),
        readJson<unknown>(path.join(directory, "trace.json"), warnings, campaignRoot),
        readJson<unknown>(path.join(directory, "executions.json"), warnings, campaignRoot),
      ])
      return {
        sessionID: entry.name,
        session,
        trace,
        executions: capturedExecutions ?? (entry.name === rootSessionID ? rootExecutions : undefined),
      }
    }),
  )
  const metrics = aggregateCapturedSessionTree(sources, rootSessionID)
  if (!metrics) return undefined
  return {
    ...metrics,
    sessions: metrics.sessions.map((session) => ({
      ...session,
      sessionId: scrubText(session.sessionId, 200),
      parentSessionId: session.parentSessionId ? scrubText(session.parentSessionId, 200) : undefined,
      title: session.title ? scrubText(session.title, 280) : undefined,
      agent: session.agent ? scrubText(session.agent, 100) : undefined,
      status: session.status ? scrubText(session.status, 80) : undefined,
    })),
    warnings: metrics.warnings.map((warning) => scrubText(warning, 400)),
  }
}

function pathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function artifactValues(...sources: unknown[]) {
  return sources.flatMap((source) => {
    if (Array.isArray(source)) return source
    if (isRecord(source)) return arrayValue(source, ["artifacts", "files", "items"])
    return []
  })
}

async function normalizeArtifact(
  value: unknown,
  runDirectory: string,
  campaignRoot: string,
): Promise<CampaignFileLink | undefined> {
  if (typeof value === "string") value = { path: value }
  if (!isRecord(value)) return undefined
  const external = text(value, ["href", "url"], 2_000)
  const label = text(value, ["label", "title", "name", "filename"], 240)
  const kind = text(value, ["kind", "type", "mimeType", "mediaType"], 120)
  const bytes = numberValue(value, ["bytes", "size", "sizeBytes"])
  if (external && /^https?:\/\//i.test(external)) return { label: label ?? external, href: external, kind, bytes }
  const rawPath = text(value, ["path", "file", "filename", "savedAs"], 2_000)
  if (!rawPath) return undefined
  const absolute = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(runDirectory, rawPath)
  if (!pathInside(campaignRoot, absolute)) return undefined
  const metadata = await lstat(absolute).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) return undefined
  const resolved = await realpath(absolute).catch(() => undefined)
  if (!resolved || !pathInside(campaignRoot, resolved)) return undefined
  return {
    label: label ?? path.basename(absolute),
    path: path.relative(campaignRoot, absolute),
    kind,
    bytes: bytes ?? metadata.size,
  }
}

async function enumerateArtifacts(directory: string, campaignRoot: string) {
  const output: CampaignFileLink[] = []
  async function visit(current: string): Promise<void> {
    if (output.length >= MAX_ARTIFACTS) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (output.length >= MAX_ARTIFACTS || entry.name.startsWith(".")) break
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(file)
      if (!entry.isFile()) continue
      const normalized = await normalizeArtifact({ path: file }, directory, campaignRoot)
      if (normalized) output.push(normalized)
    }
  }
  if ((await lstat(directory).catch(() => undefined))?.isDirectory()) await visit(directory)
  return output
}

async function collectArtifacts(
  run: PartialRunFile,
  trace: PartialTraceFile | undefined,
  trajectory: PartialTrajectoryFile | undefined,
  runDirectory: string,
  campaignRoot: string,
) {
  const candidates = artifactValues(
    first(run, ["artifacts", "outputs", "deliverables"]),
    first(trace, ["artifacts"]),
    first(trajectory, ["artifacts", "outputs", "deliverables"]),
  )
  const explicit = await Promise.all(
    candidates.slice(0, MAX_ARTIFACTS).map((item) => normalizeArtifact(item, runDirectory, campaignRoot)),
  )
  const discovered = await enumerateArtifacts(path.join(runDirectory, "artifacts"), campaignRoot)
  const seen = new Set<string>()
  return [...explicit.filter((item): item is CampaignFileLink => Boolean(item)), ...discovered].filter((item) => {
    const key = item.href ?? item.path ?? item.label
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sourceFile(root: string, file: string, kind: string): CampaignFileLink | undefined {
  return {
    label: path.basename(file),
    path: path.relative(root, file),
    kind: `raw-${kind}`,
    bytes: Bun.file(file).size,
  }
}

async function normalizeRun(runFile: string, campaignRoot: string): Promise<CampaignRunReport> {
  const directory = path.dirname(runFile)
  const warnings: string[] = []
  const run = (await readJson<PartialRunFile>(runFile, warnings, campaignRoot)) ?? {}
  const traceFile = path.join(directory, "trace.json")
  const trajectoryFile = path.join(directory, "trajectory.json")
  const executionsFile = path.join(directory, "executions.json")
  const promptFile = path.join(directory, "prompt.md")
  const finalFile = path.join(directory, "final.md")
  const eventsFile = path.join(directory, "events.ndjson")
  const [trace, trajectory, executions, promptText, finalText, events] = await Promise.all([
    readJson<PartialTraceFile>(traceFile, warnings, campaignRoot),
    readJson<PartialTrajectoryFile>(trajectoryFile, warnings, campaignRoot),
    readJson<unknown>(executionsFile, warnings, campaignRoot),
    readText(promptFile, warnings, campaignRoot, 256 * 1024),
    readText(finalFile, warnings, campaignRoot),
    summarizeEvents(eventsFile),
  ])
  const prompt = promptText ?? text(run, ["prompt", "input", "task.prompt"], MAX_TEXT_BYTES)
  const final = finalText ?? text(run, ["final", "answer", "result.final", "response"], MAX_TEXT_BYTES)
  const failures = collectFailures(run, trace)
  const startedAt = isoDate(first(run, ["startedAt", "start", "timing.startedAt", "createdAt"]))
  const completedAt = isoDate(first(run, ["completedAt", "endedAt", "end", "timing.completedAt", "updatedAt"]))
  const explicitDuration = numberValue(run, ["durationMs", "timing.durationMs", "metrics.durationMs", "elapsedMs"])
  const durationMs =
    explicitDuration ??
    numberValue(trace, ["summary.totalCompletionTimeMs", "durationMs", "summary.durationMs"]) ??
    (startedAt && completedAt
      ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
      : undefined)
  const tokens = tokenMetrics(run, trace, trajectory)
  const inference = arrayValue(trace, ["inference"])[0]
  const rootSessionId = text(run, ["sessionId", "sessionID", "session.id"], 200) ?? text(trace, ["session.id"], 200)
  const treeMetrics = await capturedTreeMetrics(directory, rootSessionId, executions, warnings, campaignRoot)
  const metrics: CampaignRunMetrics = {
    durationMs,
    timeToFirstEventMs: numberValue(run, [
      "timeToFirstEventMs",
      "metrics.timeToFirstEventMs",
      "timing.timeToFirstEventMs",
    ]),
    timeToFirstOutputMs:
      numberValue(run, [
        "timeToFirstVisibleTextMs",
        "metrics.timeToFirstVisibleTextMs",
        "timeToFirstOutputMs",
        "metrics.timeToFirstOutputMs",
        "timing.timeToFirstOutputMs",
      ]) ?? numberValue(trace, ["summary.timeToFirstUsefulOutputMs", "summary.timeToFirstOutputMs"]),
    cost:
      numberValue(run, ["cost", "metrics.cost", "usage.cost", "summary.cost"]) ??
      numberValue(trace, ["summary.cost", "cost"]),
    tokens,
    inferenceCalls:
      numberValue(run, ["inferenceCalls", "metrics.inferenceCalls", "summary.inferenceCalls"]) ??
      numberValue(trace, ["summary.inferenceCalls"]),
    toolCalls:
      numberValue(run, ["toolCalls", "metrics.toolCalls", "summary.toolCalls"]) ??
      numberValue(trace, ["summary.toolCalls"]) ??
      arrayValue(trace, ["tools"]).length,
    toolCallsPerInference:
      numberValue(run, ["toolCallsPerInference", "metrics.toolCallsPerInference"]) ??
      numberValue(trace, ["summary.toolCallsPerInference"]),
    toolExecutionMs:
      numberValue(run, ["toolExecutionMs", "metrics.toolExecutionMs"]) ??
      numberValue(trace, ["summary.toolExecutionMs"]),
    toolCriticalPathMs:
      numberValue(run, ["toolCriticalPathMs", "metrics.toolCriticalPathMs"]) ??
      numberValue(trace, ["summary.toolCriticalPathMs"]),
    toolMaxConcurrency:
      numberValue(run, ["toolMaxConcurrency", "metrics.toolMaxConcurrency"]) ??
      numberValue(trace, ["summary.toolMaxConcurrency"]),
    toolParallelism:
      numberValue(run, ["toolParallelism", "metrics.toolParallelism"]) ??
      numberValue(trace, ["summary.toolParallelism"]),
    toolContractBytes:
      numberValue(run, ["toolContractBytes", "metrics.toolContractBytes"]) ??
      numberValue(trace, ["summary.toolContractBytes"]),
    contractBytes:
      numberValue(run, ["contractBytes", "metrics.contractBytes"]) ?? numberValue(trace, ["summary.contractBytes"]),
    searches:
      numberValue(run, ["searches", "metrics.searches", "summary.searchCount"]) ??
      numberValue(trace, ["summary.searchCount"]) ??
      arrayValue(trace, ["searches"]).length,
    childAgents:
      numberValue(run, ["childAgents", "metrics.childAgents", "summary.childCount"]) ??
      numberValue(trace, ["summary.childCount"]) ??
      arrayValue(trace, ["children"]).length,
    retries:
      numberValue(run, ["retries", "metrics.retries", "summary.retryCount"]) ??
      numberValue(trace, ["summary.retryCount"]) ??
      arrayValue(trace, ["retries"]).length,
    failures:
      numberValue(run, ["failureCount", "metrics.failures", "summary.failureCount"]) ??
      Math.max(failures.length, numberValue(trace, ["summary.failureCount"]) ?? 0),
    eventCount: events.count || undefined,
    eventBytes: events.bytes || undefined,
    eventsTruncated: events.truncated || undefined,
  }
  let runStatus = status(first(run, ["status", "outcome", "state", "session.status"]))
  if (runStatus === "unknown" && completedAt) runStatus = final ? "completed" : failures.length ? "failed" : "completed"
  if (runStatus === "unknown" && final) runStatus = "completed"
  if (runStatus === "unknown" && startedAt) runStatus = "running"
  const fallbackID = relativeLabel(campaignRoot, directory).replaceAll(path.sep, "-") || "run"
  const id = cleanID(text(run, ["runId", "runID", "id", "slug"], 160), fallbackID)
  const promptId = cleanID(text(run, ["promptId", "promptID", "taskId", "task.id", "caseId"], 160), id)
  const title = cleanID(
    text(run, ["title", "promptTitle", "task.title", "name"], 280) ??
      prompt?.split(/\r?\n/).find(Boolean)?.slice(0, 280),
    promptId,
  )
  const rawProjectDirectory = text(run, ["project.directory", "projectDir", "workspace", "directory"], 2_000)
  const sourceFiles = (
    await Promise.all(
      [
        [runFile, "metadata"],
        [traceFile, "trace"],
        [trajectoryFile, "trajectory"],
        [eventsFile, "events"],
        [executionsFile, "executions"],
        [promptFile, "prompt"],
        [finalFile, "final"],
      ].map(async ([file, kind]) =>
        (await Bun.file(String(file)).exists()) ? sourceFile(campaignRoot, String(file), String(kind)) : undefined,
      ),
    )
  ).filter((item): item is CampaignFileLink => Boolean(item))
  const artifacts = await collectArtifacts(run, trace, trajectory, directory, campaignRoot)
  return {
    id,
    promptId,
    title,
    batchId: text(run, ["batchId", "batchID", "batch.id", "batch"], 160),
    status: runStatus,
    projectId: text(run, ["projectId", "projectID", "project.id"], 200),
    projectLabel:
      text(run, ["project.title", "project.name", "projectLabel"], 240) ??
      (rawProjectDirectory ? path.basename(rawProjectDirectory) : undefined),
    sessionId: rootSessionId,
    model: text(run, ["model", "model.id", "inference.model"], 240) ?? text(inference, ["model"], 240),
    provider:
      text(run, ["provider", "model.provider", "inference.provider"], 180) ?? text(inference, ["provider"], 180),
    effort: text(run, ["effort", "model.effort", "inference.effort"], 100) ?? text(inference, ["effort"], 100),
    startedAt,
    completedAt,
    metrics,
    treeMetrics,
    prompt,
    final,
    timeline: collectTimeline(trace, trajectory, executions, events),
    failures,
    artifacts,
    sourceFiles,
    directory,
    warnings,
  }
}

function normalizeImprovement(value: unknown, batchId: string, index: number): CampaignImprovement | undefined {
  if (typeof value === "string") {
    return { id: `${batchId}-improvement-${index + 1}`, title: scrubText(value, 300), batchId }
  }
  if (!isRecord(value)) return undefined
  const id = cleanID(text(value, ["id", "slug", "key"], 160), `${batchId}-improvement-${index + 1}`)
  const title = text(value, ["title", "name", "improvement", "change"], 300)
  if (!title) return undefined
  return {
    id,
    title,
    status: text(value, ["status", "state", "outcome"], 80),
    area: text(value, ["area", "harnessArea", "category", "node"], 180),
    batchId: text(value, ["batchId", "batch"], 160) ?? batchId,
    generalizable: booleanValue(value, ["generalizable", "crossTask", "notTaskSpecific"]),
    rationale: text(value, ["rationale", "reason", "description", "why"], 2_000),
    evidence: stringArray(value, ["evidence", "observations", "failures"]),
    changes: stringArray(value, ["changes", "implementation", "edits"]),
    validation: stringArray(value, ["validation", "tests", "checks"]),
    files: stringArray(value, ["files", "paths"]),
  }
}

function improvementList(value: PartialImprovementsFile | undefined, batchId: string) {
  let values = Array.isArray(value) ? value : arrayValue(value, ["improvements", "items", "ledger", "changes"])
  if (!values.length && isRecord(value)) {
    const grouped = ["implemented", "accepted", "planned", "deferred", "rejected"].flatMap((group) =>
      arrayValue(value, [group]).map((item) =>
        isRecord(item) ? { ...item, status: first(item, ["status"]) ?? group } : { title: item, status: group },
      ),
    )
    values =
      grouped.length > 0
        ? grouped
        : Object.entries(value)
            .filter(([, item]) => typeof item === "string" || isRecord(item))
            .map(([id, item]) => (isRecord(item) ? { id, ...item } : { id, title: item }))
  }
  return values
    .map((item, index) => normalizeImprovement(item, batchId, index))
    .filter((item): item is CampaignImprovement => Boolean(item))
}

async function normalizeBatch(batchFile: string, campaignRoot: string): Promise<CampaignBatchReport> {
  const directory = path.dirname(batchFile)
  const warnings: string[] = []
  const batch = (await readJson<PartialBatchFile>(batchFile, warnings, campaignRoot)) ?? {}
  const analysisFile = path.join(directory, "analysis.md")
  const improvementsFile = path.join(directory, "improvements.json")
  const [analysis, improvementsRaw] = await Promise.all([
    readText(analysisFile, warnings, campaignRoot),
    readJson<PartialImprovementsFile>(improvementsFile, warnings, campaignRoot),
  ])
  const fallbackID = path.basename(directory)
  const id = cleanID(text(batch, ["batchId", "batchID", "id", "slug"], 160), fallbackID)
  const sourceFiles = (
    await Promise.all(
      [
        [batchFile, "metadata"],
        [analysisFile, "analysis"],
        [improvementsFile, "improvements"],
      ].map(async ([file, kind]) =>
        (await Bun.file(String(file)).exists()) ? sourceFile(campaignRoot, String(file), String(kind)) : undefined,
      ),
    )
  ).filter((item): item is CampaignFileLink => Boolean(item))
  return {
    id,
    title:
      text(batch, ["title", "name", "label"], 260) ??
      `Batch ${naturalNumber(id) === Number.MAX_SAFE_INTEGER ? id : naturalNumber(id)}`,
    index:
      numberValue(batch, ["index", "batchIndex", "number"]) ??
      (naturalNumber(id) === Number.MAX_SAFE_INTEGER ? undefined : naturalNumber(id)),
    status: status(first(batch, ["status", "outcome", "state"])),
    startedAt: isoDate(first(batch, ["startedAt", "start", "createdAt"])),
    completedAt: isoDate(first(batch, ["completedAt", "end", "updatedAt"])),
    runIds: stringArray(batch, ["runIds", "runs", "prompts", "tasks"]),
    analysis,
    improvements: improvementList(improvementsRaw, id),
    sourceFiles,
    directory,
    warnings,
  }
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index]
}

function totals(runs: CampaignRunReport[], planned: number) {
  const durations = runs.map((run) => run.metrics.durationMs).filter((value): value is number => value !== undefined)
  const count = (runStatus: CampaignRunStatus) => runs.filter((run) => run.status === runStatus).length
  const missing = Math.max(0, planned - runs.length)
  const trees = runs.flatMap((run) => (run.treeMetrics ? [run.treeMetrics] : []))
  const tree = trees.length
    ? {
        runs: trees.length,
        sessions: trees.reduce((sum, item) => sum + item.sessionCount, 0),
        childSessions: trees.reduce((sum, item) => sum + item.childSessionCount, 0),
        toolCalls: trees.reduce((sum, item) => sum + item.toolCalls, 0),
        searches: trees.reduce((sum, item) => sum + item.searches, 0),
        approvals: trees.reduce((sum, item) => sum + item.approvals, 0),
        retries: trees.reduce((sum, item) => sum + item.retries, 0),
        failures: trees.reduce((sum, item) => sum + item.failures, 0),
        reportedFailures: trees.reduce((sum, item) => sum + item.reportedFailures, 0),
        executions: trees.reduce((sum, item) => sum + item.executions, 0),
        failedExecutions: trees.reduce((sum, item) => sum + item.failedExecutions, 0),
        cost: trees.reduce((sum, item) => sum + (item.cost ?? 0), 0),
        tokens: trees.reduce((sum, item) => sum + (item.tokens?.total ?? 0), 0),
      }
    : undefined
  return {
    planned,
    observed: runs.length,
    completed: count("completed"),
    running: count("running"),
    failed: count("failed"),
    partial: count("partial"),
    blocked: count("blocked"),
    inconclusive: count("inconclusive"),
    cancelled: count("cancelled"),
    pending: missing + count("pending") + count("unknown"),
    durationMs: durations.reduce((sum, value) => sum + value, 0),
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    cost: runs.reduce((sum, run) => sum + (run.metrics.cost ?? 0), 0),
    tokens: runs.reduce((sum, run) => sum + (run.metrics.tokens?.total ?? 0), 0),
    toolCalls: runs.reduce((sum, run) => sum + (run.metrics.toolCalls ?? 0), 0),
    searches: runs.reduce((sum, run) => sum + (run.metrics.searches ?? 0), 0),
    childAgents: runs.reduce((sum, run) => sum + (run.metrics.childAgents ?? 0), 0),
    retries: runs.reduce((sum, run) => sum + (run.metrics.retries ?? 0), 0),
    failures: runs.reduce((sum, run) => sum + run.metrics.failures, 0),
    tree,
  }
}

function campaignStatus(summary: ReturnType<typeof totals>): CampaignRunStatus {
  if (summary.running > 0) return "running"
  if (summary.observed < summary.planned || summary.pending > 0) return "pending"
  if (summary.failed > 0) return "failed"
  if (summary.blocked > 0) return "blocked"
  if (summary.partial > 0 || summary.inconclusive > 0) return "partial"
  if (summary.cancelled > 0) return "cancelled"
  return summary.observed > 0 ? "completed" : "pending"
}

function earliest(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort()[0]
}

function latest(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
}

function inferBatches(runs: CampaignRunReport[], batches: CampaignBatchReport[]) {
  const known = new Set(batches.map((batch) => batch.id))
  for (const batchId of new Set(runs.map((run) => run.batchId).filter((value): value is string => Boolean(value)))) {
    if (known.has(batchId)) continue
    batches.push({
      id: batchId,
      title: `Batch ${naturalNumber(batchId) === Number.MAX_SAFE_INTEGER ? batchId : naturalNumber(batchId)}`,
      index: naturalNumber(batchId) === Number.MAX_SAFE_INTEGER ? undefined : naturalNumber(batchId),
      status: "unknown",
      runIds: [],
      improvements: [],
      sourceFiles: [],
      directory: "",
      warnings: [],
    })
  }
  for (const batch of batches) {
    const expected = new Set(batch.runIds)
    const related = runs.filter(
      (run) => run.batchId === batch.id || batch.runIds.includes(run.id) || batch.runIds.includes(run.promptId),
    )
    batch.runIds = [...new Set([...batch.runIds, ...related.map((run) => run.id)])]
    const active = related.some((run) => run.status === "running")
    if (batch.status !== "unknown" && !(batch.status === "running" && !active)) continue
    if (related.some((run) => run.status === "running")) batch.status = "running"
    else if (expected.size > 0 && related.length < expected.size) batch.status = "pending"
    else if (related.some((run) => run.status === "failed")) batch.status = "failed"
    else if (related.some((run) => run.status === "blocked")) batch.status = "blocked"
    else if (related.some((run) => run.status === "partial" || run.status === "inconclusive")) batch.status = "partial"
    else if (related.some((run) => run.status === "cancelled")) batch.status = "cancelled"
    else if (related.length > 0 && related.every((run) => run.status === "completed")) batch.status = "completed"
    else batch.status = "pending"
  }
  return sortNatural(batches, (batch) => batch.id)
}

export async function loadCampaignReport(options: RenderCampaignOptions | string): Promise<CampaignReport> {
  const normalizedOptions: RenderCampaignOptions = typeof options === "string" ? { root: options } : options
  const root = path.resolve(normalizedOptions.root)
  const rootMetadata = await lstat(root).catch(() => undefined)
  if (!rootMetadata?.isDirectory()) throw new Error(`Campaign directory does not exist: ${root}`)
  const warnings: string[] = []
  const campaignFile = (await Bun.file(path.join(root, "campaign.json")).exists())
    ? path.join(root, "campaign.json")
    : path.join(root, "manifest.json")
  const campaign = (await readJson<PartialCampaignFile>(campaignFile, warnings, root)) ?? {}
  const [runFiles, batchFiles] = await Promise.all([
    findNamedFiles(root, "run.json"),
    findNamedFiles(path.join(root, "batches"), "batch.json"),
  ])
  const [runs, loadedBatches] = await Promise.all([
    Promise.all(runFiles.map((file) => normalizeRun(file, root))),
    Promise.all(batchFiles.map((file) => normalizeBatch(file, root))),
  ])
  sortNatural(runs, (run) => run.promptId)
  const batches = inferBatches(runs, loadedBatches)
  const planned =
    normalizedOptions.plannedPrompts ??
    numberValue(campaign, ["plannedPrompts", "totalPrompts", "promptCount", "manifest.total"]) ??
    DEFAULT_PLANNED_PROMPTS
  const summary = totals(runs, Math.max(planned, runs.length))
  const allWarnings = [
    ...warnings,
    ...runs.flatMap((run) => run.warnings),
    ...batches.flatMap((batch) => batch.warnings),
  ]
  const improvements = batches.flatMap((batch) => batch.improvements)
  const generatedAt = (normalizedOptions.now ?? new Date()).toISOString()
  const recordedStatus = status(first(campaign, ["status", "state", "outcome"]))
  const derivedStatus = campaignStatus(summary)
  const allObservedRunsAreTerminal = summary.pending === 0 && summary.running === 0 && summary.observed > 0
  const staleRunningStatus = recordedStatus === "running" && summary.running === 0
  const reportStatus =
    recordedStatus === "unknown" || allObservedRunsAreTerminal || staleRunningStatus ? derivedStatus : recordedStatus
  return {
    schemaVersion: 1,
    id: cleanID(text(campaign, ["campaignId", "campaignID", "id", "slug"], 160), path.basename(root)),
    title: normalizedOptions.title ?? text(campaign, ["title", "name"], 300) ?? "OpenScience harness campaign",
    status: reportStatus,
    root,
    startedAt:
      isoDate(first(campaign, ["startedAt", "start", "createdAt"])) ?? earliest(runs.map((run) => run.startedAt)),
    updatedAt:
      isoDate(first(campaign, ["updatedAt", "lastUpdatedAt"])) ??
      latest(runs.map((run) => run.completedAt ?? run.startedAt)),
    completedAt: isoDate(first(campaign, ["completedAt", "end"])),
    model: text(campaign, ["model", "model.id", "configuration.model"], 240) ?? runs.find((run) => run.model)?.model,
    provider:
      text(campaign, ["provider", "model.provider", "configuration.provider"], 180) ??
      runs.find((run) => run.provider)?.provider,
    effort:
      text(campaign, ["effort", "model.effort", "configuration.effort"], 100) ?? runs.find((run) => run.effort)?.effort,
    harnessRevision: text(
      campaign,
      ["harnessRevision", "revision", "git.commit", "configuration.harnessRevision"],
      240,
    ),
    sourceLabel: text(campaign, ["sourceLabel", "source", "promptSource", "manifest.source"], 300),
    totals: summary,
    runs,
    batches,
    improvements,
    warnings: [...new Set(allWarnings)],
    generatedAt,
  }
}

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "item"
  )
}

function integer(value: number | undefined) {
  return value === undefined ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
}

function decimal(value: number | undefined) {
  return value === undefined ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function money(value: number | undefined) {
  if (value === undefined) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value)
}

function duration(value: number | undefined) {
  if (value === undefined) return "—"
  if (value < 1_000) return `${Math.round(value)} ms`
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`
}

function bytes(value: number | undefined) {
  if (value === undefined) return ""
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / 1_048_576).toFixed(1)} MB`
}

function dateTime(value: string | undefined) {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return escapeHtml(value)
  const label = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(parsed)
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(label)}</time>`
}

function encodedRelativePath(value: string) {
  return value.split(/[\\/]/).map(encodeURIComponent).join("/")
}

function fileHref(report: CampaignReport, output: string, link: CampaignFileLink) {
  if (link.href && /^https?:\/\//i.test(link.href)) return link.href
  if (!link.path || link.kind?.startsWith("raw-")) return undefined
  const absolute = path.resolve(report.root, link.path)
  if (!pathInside(report.root, absolute)) return undefined
  const relative = path.relative(path.dirname(output), absolute)
  return encodedRelativePath(relative || path.basename(absolute))
}

function linkMarkup(report: CampaignReport, output: string, link: CampaignFileLink) {
  const href = fileHref(report, output, link)
  const metadata = [link.kind?.replace(/^raw-/, "captured "), bytes(link.bytes)].filter(Boolean).join(" · ")
  const label = escapeHtml(link.label)
  const content = `${label}${metadata ? `<span>${escapeHtml(metadata)}</span>` : ""}`
  if (!href) return `<span class="file-link file-link-muted">${content}</span>`
  const external = /^https?:\/\//i.test(href)
  return `<a class="file-link" href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noreferrer"' : ""}>${content}</a>`
}

function statusBadge(value: CampaignRunStatus | string | undefined) {
  const normalized = status(value)
  return `<span class="status status-${normalized}">${escapeHtml(normalized)}</span>`
}

function documentMarkup(value: string | undefined, empty: string) {
  if (!value?.trim()) return `<p class="empty">${escapeHtml(empty)}</p>`
  return `<pre class="document">${escapeHtml(value.trim())}</pre>`
}

function metric(label: string, value: string, note?: string) {
  return `<div class="metric"><dt>${escapeHtml(label)}</dt><dd>${value}</dd>${note ? `<p>${escapeHtml(note)}</p>` : ""}</div>`
}

function runTimeline(run: CampaignRunReport) {
  if (!run.timeline.length) return '<p class="empty">No structured timeline entries were captured.</p>'
  return `<div class="table-scroll"><table class="timeline-table">
    <thead><tr><th scope="col">Type</th><th scope="col">Activity</th><th scope="col">Status</th><th scope="col">Time</th><th scope="col" class="numeric">Duration</th></tr></thead>
    <tbody>${run.timeline
      .map(
        (entry) =>
          `<tr><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(entry.status ?? "—")}</td><td>${dateTime(entry.at)}</td><td class="numeric">${escapeHtml(duration(entry.durationMs))}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div>`
}

function runFailures(run: CampaignRunReport) {
  if (!run.failures.length) return '<p class="empty">No captured failures.</p>'
  return `<ol class="failure-list">${run.failures
    .map(
      (failure) =>
        `<li><div><strong>${escapeHtml(failure.title)}</strong>${failure.code ? `<code>${escapeHtml(failure.code)}</code>` : ""}</div>${failure.message ? `<p>${escapeHtml(failure.message)}</p>` : ""}<small>${[failure.source, failure.at].filter(Boolean).map(escapeHtml).join(" · ")}</small></li>`,
    )
    .join("")}</ol>`
}

function runFiles(report: CampaignReport, output: string, run: CampaignRunReport) {
  if (!run.artifacts.length && !run.sourceFiles.length) return '<p class="empty">No files were captured.</p>'
  return `<div class="file-groups">${
    run.artifacts.length
      ? `<section><h5>Artifacts</h5><div class="file-list">${run.artifacts.map((file) => linkMarkup(report, output, file)).join("")}</div></section>`
      : ""
  }${
    run.sourceFiles.length
      ? `<section><h5>Capture files</h5><p class="supporting-copy">Capture files are listed for provenance but intentionally not linked from this sanitized report.</p><div class="file-list">${run.sourceFiles.map((file) => linkMarkup(report, output, file)).join("")}</div></section>`
      : ""
  }</div>`
}

function runTreeMetrics(run: CampaignRunReport) {
  const tree = run.treeMetrics
  if (!tree) return '<p class="empty">No recursive session capture was available.</p>'
  const summary = [
    ["Sessions", integer(tree.sessionCount), `${integer(tree.childSessionCount)} children`],
    ["Tool calls", integer(tree.toolCalls), `${integer(run.metrics.toolCalls)} root`],
    ["Tokens", integer(tree.tokens?.total), `${integer(run.metrics.tokens?.total)} root`],
    ["Searches", integer(tree.searches), `${integer(run.metrics.searches)} root`],
    ["Approvals", integer(tree.approvals), `${integer(tree.childAgentLinks)} child links`],
    ["Failures", integer(tree.failures), `${integer(tree.reportedFailures)} reported`],
    ["Executions", integer(tree.executions), `${integer(tree.failedExecutions)} failed`],
    ["Coverage", `${integer(tree.executionSessionCount)} / ${integer(tree.sessionCount)}`, "execution queries"],
  ]
  const warnings = tree.warnings.length
    ? `<div class="tree-warnings"><strong>Capture limits</strong><ul>${tree.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>`
    : ""
  const rows = tree.sessions
    .map(
      (session) => `<tr>
        <td><strong>${escapeHtml(session.isRoot ? "Root" : (session.agent ?? "Child"))}</strong><span>${escapeHtml(session.title ?? session.sessionId)}</span></td>
        <td><code>${escapeHtml(session.sessionId)}</code></td>
        <td class="numeric">${escapeHtml(duration(session.durationMs))}</td>
        <td class="numeric">${escapeHtml(duration(session.timeToFirstOutputMs))}</td>
        <td class="numeric">${escapeHtml(integer(session.toolCalls))}</td>
        <td class="numeric">${escapeHtml(integer(session.searches))}</td>
        <td class="numeric">${escapeHtml(integer(session.approvals))}</td>
        <td class="numeric">${escapeHtml(integer(session.failures))}</td>
        <td class="numeric">${escapeHtml(integer(session.reportedFailures))}</td>
        <td class="numeric">${escapeHtml(integer(session.tokens?.total))}</td>
        <td class="numeric">${escapeHtml(integer(session.executions))}</td>
      </tr>`,
    )
    .join("")
  return `<div class="tree-metrics">
    <p class="supporting-copy">Root metrics remain the run summary. Tree metrics are raw sums across captured root and child session traces; failures are deduplicated by stable ID, then exact captured content. Reported failures remain separate because summary counts cannot be safely reconciled.</p>
    <dl class="tree-summary">${summary.map(([label, value, note]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd><small>${escapeHtml(note)}</small></div>`).join("")}</dl>
    ${warnings}
    <div class="table-scroll"><table class="session-table"><thead><tr><th>Session</th><th>ID</th><th class="numeric">Duration</th><th class="numeric">First output</th><th class="numeric">Tools</th><th class="numeric">Searches</th><th class="numeric">Approvals</th><th class="numeric">Failures</th><th class="numeric">Reported</th><th class="numeric">Tokens</th><th class="numeric">Executions</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`
}

function runDetails(report: CampaignReport, output: string, run: CampaignRunReport, index: number) {
  const anchor = `run-${index + 1}-${slug(run.promptId)}`
  const model = [run.provider, run.model, run.effort].filter(Boolean).join(" · ") || "—"
  const metadata = [
    ["Project", run.projectLabel ?? run.projectId ?? "—"],
    ["Project ID", run.projectId ?? "—"],
    ["Session", run.sessionId ?? "—"],
    ["Model", model],
    ["Started", run.startedAt ? dateTime(run.startedAt) : "—"],
    ["Completed", run.completedAt ? dateTime(run.completedAt) : "—"],
    ["First event", escapeHtml(duration(run.metrics.timeToFirstEventMs))],
    ["First visible text", escapeHtml(duration(run.metrics.timeToFirstOutputMs))],
    ["Inference calls", escapeHtml(integer(run.metrics.inferenceCalls))],
    ["Tool calls / inference", escapeHtml(decimal(run.metrics.toolCallsPerInference))],
    ["Tool execution", escapeHtml(duration(run.metrics.toolExecutionMs))],
    ["Tool critical path", escapeHtml(duration(run.metrics.toolCriticalPathMs))],
    ["Max tool concurrency", escapeHtml(integer(run.metrics.toolMaxConcurrency))],
    ["Average tool parallelism", escapeHtml(decimal(run.metrics.toolParallelism))],
    ["Tool contract", escapeHtml(bytes(run.metrics.toolContractBytes))],
    ["System + tool contract", escapeHtml(bytes(run.metrics.contractBytes))],
    ["Events", escapeHtml(integer(run.metrics.eventCount))],
    ["Metric scope", "Root session"],
    ["Captured sessions", escapeHtml(integer(run.treeMetrics?.sessionCount))],
  ]
  return `<details class="run" id="${escapeHtml(anchor)}">
    <summary>
      <span class="run-primary"><span class="prompt-id">${escapeHtml(run.promptId)}</span><span class="run-title">${escapeHtml(run.title)}</span></span>
      <span class="run-summary-metrics"><span>${statusBadge(run.status)}</span><span class="numeric">${escapeHtml(duration(run.metrics.durationMs))}</span><span class="numeric">${escapeHtml(integer(run.metrics.tokens?.total))} tokens</span><span class="numeric">${escapeHtml(money(run.metrics.cost))}</span></span>
    </summary>
    <div class="run-body">
      <dl class="metadata-grid">${metadata.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>
      <div class="run-tabs">
        <details open><summary>Prompt</summary>${documentMarkup(run.prompt, "Prompt text was not captured.")}</details>
        <details><summary>Final response</summary>${documentMarkup(run.final, "No final response was captured.")}</details>
        <details><summary>Timeline <span class="count">${integer(run.timeline.length)}</span></summary>${runTimeline(run)}</details>
        <details><summary>Session tree <span class="count">${integer(run.treeMetrics?.sessionCount)}</span></summary>${runTreeMetrics(run)}</details>
        <details${run.failures.length ? " open" : ""}><summary>Failures <span class="count">${integer(run.failures.length)}</span></summary>${runFailures(run)}</details>
        <details><summary>Artifacts and capture files <span class="count">${integer(run.artifacts.length)}</span></summary>${runFiles(report, output, run)}</details>
      </div>
    </div>
  </details>`
}

function improvementMarkup(improvement: CampaignImprovement) {
  const groups: Array<[string, string[] | undefined]> = [
    ["Evidence", improvement.evidence],
    ["Changes", improvement.changes],
    ["Validation", improvement.validation],
    ["Files", improvement.files],
  ]
  return `<article class="improvement"><header><div><p class="eyebrow">${escapeHtml(improvement.area ?? "Harness")}</p><h4>${escapeHtml(improvement.title)}</h4></div><div>${improvement.status ? `<span class="plain-badge">${escapeHtml(improvement.status)}</span>` : ""}${improvement.generalizable !== undefined ? `<span class="plain-badge">${improvement.generalizable ? "general" : "task-specific"}</span>` : ""}</div></header>${improvement.rationale ? `<p>${escapeHtml(improvement.rationale)}</p>` : ""}${groups
    .filter(([, values]) => values?.length)
    .map(
      ([label, values]) =>
        `<section><h5>${label}</h5><ul>${values!.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`,
    )
    .join("")}</article>`
}

function batchMarkup(report: CampaignReport, output: string, batch: CampaignBatchReport) {
  const related = report.runs.filter((run) => batch.runIds.includes(run.id) || run.batchId === batch.id)
  const durationMs = related.reduce((sum, run) => sum + (run.metrics.durationMs ?? 0), 0)
  return `<details class="batch" id="batch-${escapeHtml(slug(batch.id))}">
    <summary><span><strong>${escapeHtml(batch.title)}</strong><small>${integer(related.length)} runs · ${duration(durationMs)}</small></span>${statusBadge(batch.status)}</summary>
    <div class="batch-body">
      <dl class="metadata-grid compact"><div><dt>Started</dt><dd>${dateTime(batch.startedAt)}</dd></div><div><dt>Completed</dt><dd>${dateTime(batch.completedAt)}</dd></div><div><dt>Improvements</dt><dd>${integer(batch.improvements.length)}</dd></div></dl>
      <section><h4>Analysis</h4>${documentMarkup(batch.analysis, "Batch analysis has not been written yet.")}</section>
      ${batch.improvements.length ? `<section><h4>Harness improvements</h4><div class="improvement-list">${batch.improvements.map(improvementMarkup).join("")}</div></section>` : ""}
      ${batch.sourceFiles.length ? `<section><h4>Batch files</h4><div class="file-list">${batch.sourceFiles.map((file) => linkMarkup(report, output, file)).join("")}</div></section>` : ""}
    </div>
  </details>`
}

function overviewTable(report: CampaignReport) {
  return `<div class="table-scroll"><table>
    <thead><tr><th scope="col">Prompt</th><th scope="col">Batch</th><th scope="col">Status</th><th scope="col" class="numeric">Duration</th><th scope="col" class="numeric">Tokens</th><th scope="col" class="numeric">Cost</th><th scope="col" class="numeric">Failures</th></tr></thead>
    <tbody>${report.runs
      .map(
        (run, index) =>
          `<tr><td><a href="#run-${index + 1}-${escapeHtml(slug(run.promptId))}"><strong>${escapeHtml(run.promptId)}</strong><span>${escapeHtml(run.title)}</span></a></td><td>${escapeHtml(run.batchId ?? "—")}</td><td>${statusBadge(run.status)}</td><td class="numeric">${escapeHtml(duration(run.metrics.durationMs))}</td><td class="numeric">${escapeHtml(integer(run.metrics.tokens?.total))}</td><td class="numeric">${escapeHtml(money(run.metrics.cost))}</td><td class="numeric">${escapeHtml(integer(run.metrics.failures))}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div>`
}

const styles = `
  :root {
    color-scheme: dark;
    --bg: #171714;
    --surface: #1e1e1a;
    --surface-raised: #24241f;
    --text: #ecebe4;
    --muted: #aaa89e;
    --faint: #7f7d74;
    --border: rgba(236, 235, 228, 0.11);
    --border-strong: rgba(236, 235, 228, 0.19);
    --accent: #d47a5f;
    --accent-soft: rgba(212, 122, 95, 0.14);
    --green: #91b88d;
    --green-soft: rgba(100, 154, 98, 0.14);
    --amber: #d7ae69;
    --amber-soft: rgba(215, 174, 105, 0.14);
    --red: #e18470;
    --red-soft: rgba(198, 77, 53, 0.16);
    --blue: #91abc9;
    --blue-soft: rgba(101, 137, 179, 0.15);
    --radius: 10px;
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 24px;
    --space-6: 32px;
    --space-7: 48px;
    --font-xs: 0.75rem;
    --font-sm: 0.875rem;
    --font-md: 1rem;
    --font-lg: 1.25rem;
    --font-xl: 1.75rem;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 16px; font-optical-sizing: auto; font-synthesis: none; -webkit-font-smoothing: antialiased; }
  body { margin: 0; background: var(--bg); color: var(--text); font-size: var(--font-sm); line-height: 1.5; }
  a { color: inherit; text-underline-offset: 0.2em; }
  h1, h2, h3, h4, h5, p { margin-top: 0; }
  h1, h2, h3 { letter-spacing: -0.025em; text-wrap: balance; }
  h1 { margin-bottom: var(--space-2); font-size: clamp(1.6rem, 4vw, 2.3rem); line-height: 1.15; font-weight: 610; }
  h2 { margin-bottom: var(--space-4); font-size: var(--font-lg); font-weight: 610; }
  h3, h4 { font-size: var(--font-md); font-weight: 610; }
  h5 { margin-bottom: var(--space-2); font-size: var(--font-xs); color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; font-variant-numeric: tabular-nums slashed-zero; }
  .numeric, time, .metric dd, .prompt-id, .count { font-variant-numeric: tabular-nums; }
  .shell { width: min(1500px, 100%); margin: 0 auto; padding: var(--space-6); }
  .masthead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-5); align-items: end; padding: var(--space-5) 0 var(--space-6); border-bottom: 1px solid var(--border); }
  .eyebrow { margin-bottom: var(--space-2); color: var(--muted); font-size: var(--font-xs); font-weight: 620; letter-spacing: 0.08em; text-transform: uppercase; }
  .lede { max-width: 75ch; margin: 0; color: var(--muted); font-size: var(--font-md); text-wrap: pretty; }
  .masthead-meta { display: grid; grid-template-columns: repeat(2, auto); gap: var(--space-1) var(--space-4); margin: 0; font-size: var(--font-xs); }
  .masthead-meta dt { color: var(--faint); }
  .masthead-meta dd { margin: 0; color: var(--muted); text-align: right; }
  nav { position: sticky; top: 0; z-index: 5; display: flex; gap: var(--space-1); overflow-x: auto; margin: 0 calc(var(--space-3) * -1); padding: var(--space-3); background: color-mix(in srgb, var(--bg) 94%, transparent); border-bottom: 1px solid var(--border); backdrop-filter: blur(12px); }
  nav a { display: inline-flex; align-items: center; min-height: 32px; padding: 0 var(--space-3); border-radius: 7px; color: var(--muted); text-decoration: none; white-space: nowrap; }
  nav a:hover, nav a:focus-visible { background: var(--surface-raised); color: var(--text); outline: none; }
  main > section { padding: var(--space-7) 0; border-bottom: 1px solid var(--border); scroll-margin-top: 64px; }
  .section-heading { display: flex; justify-content: space-between; gap: var(--space-4); align-items: baseline; }
  .section-heading p { max-width: 72ch; color: var(--muted); }
  .progress-card { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: var(--space-4); align-items: center; padding: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .progress-label { display: flex; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
  progress { width: 100%; height: 8px; overflow: hidden; appearance: none; border: 0; border-radius: 999px; background: var(--surface-raised); }
  progress::-webkit-progress-bar { background: var(--surface-raised); }
  progress::-webkit-progress-value { background: var(--accent); }
  progress::-moz-progress-bar { background: var(--accent); }
  .progress-number { font-size: var(--font-lg); font-weight: 610; font-variant-numeric: tabular-nums; }
  .metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; margin: var(--space-4) 0 0; overflow: hidden; background: var(--border); border: 1px solid var(--border); border-radius: var(--radius); }
  .metric { min-width: 0; padding: var(--space-4); background: var(--surface); }
  .metric dt { color: var(--muted); font-size: var(--font-xs); }
  .metric dd { margin: var(--space-1) 0 0; overflow: hidden; font-size: var(--font-lg); font-weight: 590; text-overflow: ellipsis; }
  .metric p { margin: var(--space-1) 0 0; color: var(--faint); font-size: var(--font-xs); }
  .table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
  th, td { padding: var(--space-3); border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 570; white-space: nowrap; }
  td { color: var(--muted); }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: rgba(255, 255, 255, 0.018); }
  td a { display: grid; gap: 2px; min-width: 240px; text-decoration: none; }
  td a strong { color: var(--text); }
  td.numeric, th.numeric { text-align: right; white-space: nowrap; }
  .status, .plain-badge { display: inline-flex; align-items: center; min-height: 22px; padding: 1px var(--space-2); border-radius: 999px; font-size: var(--font-xs); line-height: 1; white-space: nowrap; }
  .status-completed { color: var(--green); background: var(--green-soft); }
  .status-running { color: var(--blue); background: var(--blue-soft); }
  .status-failed { color: var(--red); background: var(--red-soft); }
  .status-blocked { color: var(--red); background: var(--red-soft); }
  .status-partial, .status-inconclusive { color: var(--amber); background: var(--amber-soft); }
  .status-cancelled { color: var(--amber); background: var(--amber-soft); }
  .status-pending, .status-unknown, .plain-badge { color: var(--muted); background: rgba(255, 255, 255, 0.055); }
  .batch-list, .run-list { display: grid; gap: var(--space-2); }
  details { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  details > summary { min-height: 44px; cursor: pointer; list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  details > summary::after { content: "+"; color: var(--faint); font-size: var(--font-md); }
  details[open] > summary::after { content: "−"; }
  .batch > summary { display: flex; justify-content: space-between; gap: var(--space-4); align-items: center; padding: var(--space-3) var(--space-4); }
  .batch > summary > span:first-child { display: grid; }
  .batch > summary small { color: var(--muted); }
  .batch-body, .run-body { padding: 0 var(--space-4) var(--space-4); border-top: 1px solid var(--border); }
  .batch-body > section { margin-top: var(--space-5); }
  .metadata-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-4); margin: 0; padding: var(--space-4) 0; }
  .metadata-grid.compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .metadata-grid div { min-width: 0; }
  .metadata-grid dt { color: var(--faint); font-size: var(--font-xs); }
  .metadata-grid dd { margin: var(--space-1) 0 0; overflow-wrap: anywhere; }
  .run > summary { display: grid; grid-template-columns: minmax(0, 1fr) auto 20px; gap: var(--space-4); align-items: center; padding: var(--space-3) var(--space-4); }
  .run-primary { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: var(--space-3); align-items: baseline; min-width: 0; }
  .prompt-id { color: var(--accent); font-size: var(--font-xs); font-weight: 630; }
  .run-title { overflow: hidden; font-size: var(--font-sm); font-weight: 570; text-overflow: ellipsis; white-space: nowrap; }
  .run-summary-metrics { display: grid; grid-template-columns: 88px 88px 116px 80px; gap: var(--space-3); align-items: center; color: var(--muted); font-size: var(--font-xs); text-align: right; }
  .run-tabs { display: grid; gap: var(--space-2); }
  .run-tabs > details { background: var(--surface-raised); }
  .run-tabs > details > summary { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); font-weight: 560; }
  .run-tabs > details > summary::after { margin-left: auto; }
  .run-tabs > details > :not(summary) { margin: 0; border-top: 1px solid var(--border); }
  .count { color: var(--faint); font-size: var(--font-xs); font-weight: 450; }
  .document { max-height: 70vh; overflow: auto; padding: var(--space-4); color: var(--text); font: inherit; line-height: 1.58; white-space: pre-wrap; overflow-wrap: anywhere; text-wrap: pretty; }
  .empty, .supporting-copy { color: var(--faint); }
  .run-tabs .empty { padding: var(--space-4); }
  .tree-metrics { display: grid; gap: var(--space-4); padding: var(--space-4); }
  .tree-metrics > .supporting-copy { margin: 0; max-width: 90ch; }
  .tree-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; overflow: hidden; margin: 0; border: 1px solid var(--border); border-radius: 7px; background: var(--border); }
  .tree-summary > div { min-width: 0; padding: var(--space-3); background: var(--surface); }
  .tree-summary dt, .tree-summary small { color: var(--faint); font-size: var(--font-xs); }
  .tree-summary dd { margin: var(--space-1) 0; font-size: var(--font-md); font-variant-numeric: tabular-nums; }
  .tree-warnings { padding: var(--space-3); border-radius: 7px; background: var(--amber-soft); color: var(--muted); }
  .tree-warnings ul { margin: var(--space-2) 0 0; padding-left: var(--space-5); }
  .session-table td:first-child { display: grid; gap: 2px; min-width: 200px; }
  .session-table td:first-child span { color: var(--faint); }
  .session-table code { white-space: nowrap; }
  .failure-list { display: grid; gap: var(--space-2); padding: var(--space-4) var(--space-4) var(--space-4) var(--space-7); }
  .failure-list li { padding-left: var(--space-2); }
  .failure-list li > div { display: flex; gap: var(--space-2); align-items: center; }
  .failure-list p { margin: var(--space-1) 0; color: var(--red); white-space: pre-wrap; }
  .failure-list small { color: var(--faint); }
  .file-groups { display: grid; gap: var(--space-4); padding: var(--space-4); }
  .file-groups section { min-width: 0; }
  .file-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-2); }
  .file-link { display: flex; justify-content: space-between; gap: var(--space-3); min-height: 40px; padding: var(--space-2) var(--space-3); overflow: hidden; border: 1px solid var(--border); border-radius: 7px; color: var(--text); text-decoration: none; }
  .file-link span { color: var(--faint); font-size: var(--font-xs); white-space: nowrap; }
  a.file-link:hover, a.file-link:focus-visible { border-color: var(--border-strong); background: rgba(255, 255, 255, 0.025); outline: none; }
  .file-link-muted { color: var(--muted); }
  .improvement-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-3); }
  .improvement { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .improvement header { display: flex; justify-content: space-between; gap: var(--space-3); }
  .improvement header > div:last-child { display: flex; gap: var(--space-1); align-items: flex-start; }
  .improvement h4 { margin-bottom: var(--space-3); }
  .improvement p, .improvement li { color: var(--muted); }
  .improvement section { margin-top: var(--space-4); }
  .improvement ul { margin: 0; padding-left: var(--space-5); }
  .warnings { padding: var(--space-4); border: 1px solid color-mix(in srgb, var(--amber) 30%, transparent); border-radius: var(--radius); background: var(--amber-soft); }
  .section-spacer { height: var(--space-5); }
  .warnings ul { margin-bottom: 0; }
  footer { display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-5) 0; color: var(--faint); font-size: var(--font-xs); }
  @media (max-width: 980px) {
    .metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .metadata-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tree-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .run > summary { grid-template-columns: minmax(0, 1fr) 20px; }
    .run-summary-metrics { grid-column: 1 / -1; grid-row: 2; grid-template-columns: repeat(4, minmax(80px, 1fr)); text-align: left; }
  }
  @media (max-width: 680px) {
    .shell { padding: var(--space-4); }
    .masthead { grid-template-columns: 1fr; }
    .masthead-meta dd { text-align: left; }
    .progress-card { grid-template-columns: 1fr; }
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metadata-grid, .metadata-grid.compact { grid-template-columns: 1fr; }
    .tree-summary { grid-template-columns: 1fr; }
    .run-primary { grid-template-columns: 40px minmax(0, 1fr); }
    .run-summary-metrics { grid-template-columns: repeat(2, minmax(100px, 1fr)); }
    .run-title { white-space: normal; }
    .section-heading, footer { display: block; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
  @media print {
    :root { color-scheme: light; --bg: #fff; --surface: #fff; --surface-raised: #f7f7f5; --text: #151513; --muted: #595850; --faint: #77756e; --border: rgba(0, 0, 0, 0.14); --border-strong: rgba(0, 0, 0, 0.24); }
    .shell { width: 100%; padding: 0; }
    nav { display: none; }
    main > section { break-inside: avoid; }
    details { break-inside: avoid; }
    details > :not(summary) { display: block !important; }
    .document { max-height: none; overflow: visible; }
    a { text-decoration: none; }
  }
`

export function renderCampaignHtml(report: CampaignReport, output = path.join(report.root, "index.html")) {
  const completedOrFailed =
    report.totals.completed +
    report.totals.partial +
    report.totals.blocked +
    report.totals.inconclusive +
    report.totals.failed +
    report.totals.cancelled
  const progress = report.totals.planned ? Math.min(100, (completedOrFailed / report.totals.planned) * 100) : 0
  const configuration = [report.provider, report.model, report.effort].filter(Boolean).join(" · ") || "Not recorded"
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${escapeHtml(report.title)}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <div><p class="eyebrow">OpenScience evaluation</p><h1>${escapeHtml(report.title)}</h1><p class="lede">A results-first view of campaign progress, observable trajectories, batch analyses, and general harness changes. Hidden reasoning and raw tool payloads are not included.</p></div>
      <dl class="masthead-meta"><dt>Status</dt><dd>${statusBadge(report.status)}</dd><dt>Configuration</dt><dd>${escapeHtml(configuration)}</dd><dt>Revision</dt><dd><code>${escapeHtml(report.harnessRevision ?? "Not recorded")}</code></dd><dt>Generated</dt><dd>${dateTime(report.generatedAt)}</dd></dl>
    </header>
    <nav aria-label="Report sections"><a href="#overview">Overview</a><a href="#runs">Runs</a><a href="#batches">Batches</a><a href="#improvements">Improvements</a></nav>
    <main>
      <section id="overview">
        <div class="section-heading"><div><p class="eyebrow">Campaign</p><h2>Progress and resource use</h2></div><p>${escapeHtml(report.sourceLabel ?? "Twenty scientific prompts, evaluated in batches with harness refinement between batches.")}</p></div>
        <div class="progress-card"><div><div class="progress-label"><span>Resolved prompts</span><strong class="numeric">${integer(completedOrFailed)} / ${integer(report.totals.planned)}</strong></div><progress max="${report.totals.planned}" value="${completedOrFailed}" aria-label="${integer(completedOrFailed)} of ${integer(report.totals.planned)} prompts resolved"></progress></div><div class="progress-number">${progress.toFixed(0)}%</div></div>
        <dl class="metric-grid">
          ${metric("Completed", integer(report.totals.completed), `${integer(report.totals.partial)} partial · ${integer(report.totals.blocked)} blocked`)}
          ${metric("Median duration", duration(report.totals.medianDurationMs), `p95 ${duration(report.totals.p95DurationMs)}`)}
          ${metric("Aggregate runtime", duration(report.totals.durationMs))}
          ${metric(report.totals.tree ? "Tree tokens" : "Tokens", integer(report.totals.tree?.tokens ?? report.totals.tokens), report.totals.tree ? `${integer(report.totals.tokens)} root` : undefined)}
          ${metric("Model cost", money(report.totals.cost))}
          ${metric(report.totals.tree ? "Tree failures" : "Failures", integer(report.totals.tree?.failures ?? report.totals.failures), report.totals.tree ? `${integer(report.totals.failures)} root · ${integer(report.totals.tree.reportedFailures)} reported` : `${integer(report.totals.retries)} retries`)}
          ${metric(report.totals.tree ? "Tree tool calls" : "Tool calls", integer(report.totals.tree?.toolCalls ?? report.totals.toolCalls), report.totals.tree ? `${integer(report.totals.toolCalls)} root` : undefined)}
          ${metric(report.totals.tree ? "Tree searches" : "Searches", integer(report.totals.tree?.searches ?? report.totals.searches), report.totals.tree ? `${integer(report.totals.searches)} root` : undefined)}
          ${metric(report.totals.tree ? "Child sessions" : "Sub-agents", integer(report.totals.tree?.childSessions ?? report.totals.childAgents), report.totals.tree ? `${integer(report.totals.tree.approvals)} approvals` : undefined)}
          ${metric("Harness changes", integer(report.improvements.length), `${integer(report.batches.length)} batches captured`)}
        </dl>
        <div class="section-spacer" aria-hidden="true"></div>
        ${report.runs.length ? overviewTable(report) : '<p class="empty">No runs have been captured yet.</p>'}
      </section>
      <section id="runs">
        <div class="section-heading"><div><p class="eyebrow">Trajectories</p><h2>Per-run evidence</h2></div><p>Expand a run to inspect its prompt, final response, observable activity timeline, failures, and saved artifacts.</p></div>
        <div class="run-list">${report.runs.map((run, index) => runDetails(report, output, run, index)).join("") || '<p class="empty">Runs will appear here as each project starts.</p>'}</div>
      </section>
      <section id="batches">
        <div class="section-heading"><div><p class="eyebrow">Analysis loop</p><h2>Batch reviews</h2></div><p>Each review covers up to three independent projects before the next harness revision.</p></div>
        <div class="batch-list">${report.batches.map((batch) => batchMarkup(report, output, batch)).join("") || '<p class="empty">No batch analyses have been captured yet.</p>'}</div>
      </section>
      <section id="improvements">
        <div class="section-heading"><div><p class="eyebrow">Improvement ledger</p><h2>General harness changes</h2></div><p>Changes are tied to observed evidence and separated from task-specific follow-ups.</p></div>
        <div class="improvement-list">${report.improvements.map(improvementMarkup).join("") || '<p class="empty">No harness improvements have been recorded yet.</p>'}</div>
      </section>
      ${report.warnings.length ? `<section><div class="warnings"><h2>Capture warnings</h2><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div></section>` : ""}
    </main>
    <footer><span>Campaign ${escapeHtml(report.id)}</span><span>Observable metadata only · no hidden reasoning · obvious credentials redacted</span></footer>
  </div>
</body>
</html>`
}

export async function renderCampaignDashboard(options: RenderCampaignOptions | string) {
  const normalizedOptions: RenderCampaignOptions = typeof options === "string" ? { root: options } : options
  const report = await loadCampaignReport(normalizedOptions)
  const output = path.resolve(normalizedOptions.output ?? path.join(report.root, "dashboard", "index.html"))
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  await Bun.write(temporary, renderCampaignHtml(report, output))
  await rename(temporary, output)
  return { report, output }
}

async function main() {
  const args = Bun.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun evals/cadence-harness/render.ts <campaign-dir> [output.html]")
    return
  }
  const root = path.resolve(args[0] ?? path.join(moduleDirectory, "campaign"))
  const output = args[1] ? path.resolve(args[1]) : undefined
  const result = await renderCampaignDashboard({ root, output })
  console.log(
    `Rendered ${result.report.totals.observed}/${result.report.totals.planned} runs and ${result.report.batches.length} batches to ${result.output}`,
  )
}

if (import.meta.main) await main()
