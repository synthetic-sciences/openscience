import path from "node:path"
import { appendFile, chmod, mkdir, readFile, rename } from "node:fs/promises"
import { createOpenScienceClient, createOpenScienceRuntime } from "@synsci/sdk/v2"
import { aggregateCapturedSessionTree, type CapturedSessionSource } from "./tree-metrics"

type Json = Record<string, any>
export type CampaignPrompt = {
  id: string
  ordinal: number
  title: string
  text: string
  sha256: string
  batchIndex: number
  batchPosition: number
}

const DEFAULT_CAMPAIGN = path.join(import.meta.dir, "campaigns", "cadence-cloud-20")
const DEFAULT_BASE_URL = "http://127.0.0.1:4096"
const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol"
const DEFAULT_MODEL_EFFORT = "high"
const DEFAULT_RESEARCH_EFFORT = "normal"
const DEFAULT_TIMEOUT_MINUTES = 120
const MAX_CAPTURE_OUTPUT = 100_000
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

function flags(tokens: string[]) {
  const output = new Map<string, string | true>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith("--")) continue
    const next = tokens[index + 1]
    output.set(token.slice(2), next && !next.startsWith("--") ? next : true)
    if (next && !next.startsWith("--")) index += 1
  }
  return output
}

function sha256(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function promptRunID(prompt: Pick<CampaignPrompt, "ordinal">) {
  return `p${String(prompt.ordinal).padStart(2, "0")}`
}

export function parseModelKey(model: string) {
  const separator = model.indexOf("/")
  const providerID = separator > 0 ? model.slice(0, separator) : ""
  const modelID = separator > 0 ? model.slice(separator + 1) : ""
  if (!providerID || !modelID) throw new Error(`Model must be provider/model, received ${model}`)
  return { providerID, modelID }
}

export type CampaignOutcome = "completed" | "partial" | "blocked" | "failed" | "cancelled"

export function isUserCancellation(value: unknown, marker?: unknown) {
  if (value && typeof value === "object") {
    const event = value as Json
    if (event.type === "runtime.cancelled" && event.properties?.source === "user") return true
  }
  if (!marker || typeof marker !== "object") return false
  const evidence = marker as Json
  return (
    evidence.source === "user" &&
    evidence.evidence === "operator_asserted_session_abort" &&
    typeof evidence.sessionId === "string" &&
    typeof evidence.runtimeRunId === "string" &&
    typeof evidence.at === "string"
  )
}

export function resumeCheckpoint(value: unknown) {
  if (!value || typeof value !== "object") return
  const run = value as Json
  if (run.status !== "running") return
  if (![run.projectId, run.sessionId, run.runtimeRunId].every((item) => typeof item === "string" && item)) return
  const acceptedAt = Number(run.runtimeAcceptedAt ?? Date.parse(String(run.startedAt ?? "")))
  if (!Number.isFinite(acceptedAt)) return
  const sequence = Number(run.runtimeAfterSequence ?? 0)
  return {
    projectId: run.projectId as string,
    projectLabel: typeof run.projectLabel === "string" ? run.projectLabel : undefined,
    sessionId: run.sessionId as string,
    runtimeRunId: run.runtimeRunId as string,
    acceptedAt,
    afterSequence: Number.isFinite(sequence) && sequence >= 0 ? sequence : 0,
  }
}

export function campaignOutcome(input: {
  timedOut?: boolean
  userAborted?: boolean
  terminalType?: string
  terminalError?: unknown
  assistantError?: unknown
  finalText?: string
  artifactCount?: number
}): { status: CampaignOutcome; reason?: string } {
  const usable = Boolean(input.finalText?.trim()) || Number(input.artifactCount ?? 0) > 0
  const errors = [input.terminalError, input.assistantError].filter(
    (value) => value !== undefined && value !== null && value !== "",
  )
  const errorText = errors
    .map((value) => JSON.stringify(value))
    .join(" ")
    .toLowerCase()
  const failed = input.terminalType === "runtime.failed" || errors.length > 0
  if (input.timedOut) return { status: usable ? "partial" : "failed", reason: "runner_timeout" }
  if (input.userAborted) return { status: "cancelled", reason: "user_cancelled" }
  if (failed) {
    if (usable) return { status: "partial", reason: "error_after_usable_output" }
    if (/bio_policy|policy|safety|content_filter/.test(errorText))
      return { status: "blocked", reason: "provider_policy" }
    return { status: "failed", reason: "runtime_error" }
  }
  if (!input.terminalType) return { status: usable ? "partial" : "failed", reason: "runtime_terminal_missing" }
  if (!usable) return { status: "failed", reason: "no_usable_output" }
  return { status: "completed" }
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n"
}

function scrub(value: string, maximum = MAX_CAPTURE_OUTPUT) {
  const safe = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|thk)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted-token]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
  return safe.length <= maximum ? safe : `${safe.slice(0, maximum)}\n[truncated]`
}

function sensitiveKey(key: string, value: unknown) {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (/apikey|secret|password|authorization|privatekey|credential/.test(compact)) return true
  if (["token", "accesstoken", "refreshtoken", "idtoken", "bearertoken"].includes(compact)) return true
  // Hidden chain-of-thought fields are not observable campaign data. Numeric
  // reasoning token counts and public settings such as reasoningEffort remain.
  if (["reasoningcontent", "reasoningdetails", "reasoningtext", "thinking", "encryptedcontent"].includes(compact))
    return true
  return compact === "reasoning" && typeof value === "string"
}

export function safeValue(value: unknown): unknown {
  if (typeof value === "string") return scrub(value)
  if (Array.isArray(value)) return value.map(safeValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Json).map(([key, item]) =>
      sensitiveKey(key, item) ? [key, "[redacted]"] : [key, safeValue(item)],
    ),
  )
}

async function writeAtomic(file: string, value: unknown, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}-${crypto.randomUUID()}`
  await Bun.write(temporary, typeof value === "string" ? value : json(value))
  await chmod(temporary, mode)
  await rename(temporary, file)
}

async function settleCleanup(promises: Array<Promise<unknown> | undefined>, timeoutMs = 5_000) {
  await Promise.race([Promise.allSettled(promises), Bun.sleep(timeoutMs)])
}

async function command(args: string[], cwd = process.cwd()) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function gitFingerprint(root: string) {
  const [head, tracked, staged, status] = await Promise.all([
    command(["git", "rev-parse", "HEAD"], root),
    command(["git", "diff", "--binary"], root),
    command(["git", "diff", "--cached", "--binary"], root),
    command(["git", "status", "--porcelain=v1", "-z"], root),
  ])
  const combined = `${tracked.stdout}\0${staged.stdout}\0${status.stdout}`
  return {
    head: head.stdout.trim(),
    dirty: status.stdout.length > 0,
    trackedDiffHash: sha256(tracked.stdout),
    stagedDiffHash: sha256(staged.stdout),
    worktreeHash: sha256(combined),
    statusHash: sha256(status.stdout),
  }
}

async function unwrap<T>(value: Promise<{ data?: T; error?: unknown }> | { data?: T; error?: unknown }): Promise<T> {
  const result = await value
  if (result.data === undefined)
    throw new Error(`OpenScience API returned no data: ${scrub(JSON.stringify(result.error))}`)
  return result.data
}

async function preflight(baseUrl: string, model: string) {
  const root = createOpenScienceClient({ baseUrl })
  const [healthResponse, accountResponse, providers] = await Promise.all([
    fetch(new URL("/global/health", baseUrl)),
    fetch(new URL("/account/session", baseUrl)),
    unwrap<any>(root.provider.list()),
  ])
  if (!healthResponse.ok) throw new Error(`Backend health failed: ${healthResponse.status}`)
  if (!accountResponse.ok) throw new Error(`Account preflight failed: ${accountResponse.status}`)
  const { providerID, modelID } = parseModelKey(model)
  if (!providers.connected?.includes(providerID)) throw new Error(`Provider ${providerID} is not connected`)
  const provider = providers.all?.find((item: Json) => item.id === providerID)
  if (!provider?.models?.[modelID]) throw new Error(`Model ${model} is not in the live provider catalog`)
  return {
    health: await healthResponse.json(),
    account: await accountResponse.json(),
    providerID,
    modelID,
    model: safeValue(provider.models[modelID]),
  }
}

export function isUnsafeHost(host: string) {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (["localhost", "0.0.0.0", "::", "::1"].includes(lower)) return true
  if (/^127\./.test(lower) || /^10\./.test(lower) || /^192\.168\./.test(lower)) return true
  const match = lower.match(/^172\.(\d+)\./)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  if (/^169\.254\./.test(lower) || lower === "metadata.google.internal") return true
  return false
}

export function permissionDecision(request: Json) {
  const permission = String(request.permission ?? "")
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {}
  if (permission === "network") {
    const host = String((metadata as Json).network?.host ?? request.patterns?.[0] ?? "")
    return isUnsafeHost(host)
      ? { reply: "reject" as const, reason: `blocked non-public network destination ${host || "(unknown)"}` }
      : { reply: "once" as const, reason: `one public-host network request: ${host || "scoped request"}` }
  }
  if (["websearch", "webfetch", "atlas"].includes(permission)) {
    return { reply: "once" as const, reason: `one scoped ${permission} action for this evaluation` }
  }
  if (permission === "mcp") {
    return {
      reply: "reject" as const,
      reason: "MCP actions require an explicit audited campaign allowlist; none is configured",
    }
  }
  if (permission === "environment_mutation") {
    return {
      reply: "reject" as const,
      reason: "environment mutation requires explicit campaign opt-in; none is configured",
    }
  }
  if (permission === "compute_job") {
    const provider = String((metadata as Json).provider ?? (metadata as Json).target ?? "local")
    return provider === "local"
      ? { reply: "once" as const, reason: "one bounded local compute plan" }
      : { reply: "reject" as const, reason: `remote compute is outside this campaign: ${provider}` }
  }
  if (["external_directory", "modal", "remote_compute", "doom_loop"].includes(permission)) {
    return { reply: "reject" as const, reason: `${permission} is outside the evaluation boundary` }
  }
  return { reply: "reject" as const, reason: `unrecognized permission ${permission || "(missing)"}` }
}

async function permissionPump(client: ReturnType<typeof createOpenScienceClient>, file: string, signal: AbortSignal) {
  const decided = new Set<string>()
  while (!signal.aborted) {
    const pending = await unwrap<any[]>(client.permission.list()).catch(() => [])
    for (const request of pending) {
      if (decided.has(request.id)) continue
      const decision = permissionDecision(request)
      const record = {
        requestID: request.id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: safeValue(request.patterns),
        metadata: safeValue(request.metadata),
        decision: decision.reply,
        reason: decision.reason,
        at: new Date().toISOString(),
      }
      try {
        await unwrap(
          client.permission.reply({ requestID: request.id, reply: decision.reply, message: decision.reason }),
        )
        decided.add(request.id)
        await appendFile(file, JSON.stringify({ ...record, delivered: true }) + "\n", { mode: 0o600 })
      } catch (error) {
        await appendFile(
          file,
          JSON.stringify({
            ...record,
            delivered: false,
            error: scrub(error instanceof Error ? error.message : String(error)),
          }) + "\n",
          { mode: 0o600 },
        )
      }
    }
    await Bun.sleep(250)
  }
}

export function observableRuntimeEvent(event: Json) {
  const value = safeValue(event) as Json
  const part = value.properties?.part as Json | undefined
  if (!part || !["reasoning", "snapshot", "patch"].includes(String(part.type))) return value
  return {
    sequence: value.sequence,
    sessionID: value.sessionID,
    runID: value.runID,
    type: value.type,
    properties: {
      part: {
        id: part.id,
        sessionID: part.sessionID,
        messageID: part.messageID,
        type: part.type,
        time: part.time,
        hidden: true,
      },
    },
    time: value.time,
  }
}

export function observableMessages(messages: any[]) {
  return messages.map((message) => ({
    info: safeValue(message.info),
    parts: (message.parts ?? []).flatMap((part: Json) => {
      if (["reasoning", "snapshot", "patch"].includes(String(part.type))) return []
      if (part.type !== "tool") return [safeValue(part)]
      const state = part.state ?? {}
      return [
        safeValue({
          ...part,
          state: {
            status: state.status,
            input: state.input,
            title: state.title,
            output: typeof state.output === "string" ? scrub(state.output, MAX_CAPTURE_OUTPUT) : state.output,
            metadata: state.metadata,
            time: state.time,
            error: state.error,
          },
        }),
      ]
    }),
  }))
}

export async function captureSessions(
  client: ReturnType<typeof createOpenScienceClient>,
  sessionID: string,
  rawRoot: string,
  visited = new Set<string>(),
): Promise<CapturedSessionSource[]> {
  if (visited.has(sessionID)) return []
  visited.add(sessionID)
  const directory = path.join(rawRoot, sessionID)
  await mkdir(directory, { recursive: true })
  const [session, messages, trace, children, filesystem, discoveredArtifacts, executions] = await Promise.all([
    unwrap<any>(client.session.get({ sessionID })).catch((error) => ({ error: String(error) })),
    unwrap<any[]>(client.session.messages({ sessionID, limit: 10_000 })).catch((error) => [{ error: String(error) }]),
    unwrap<any>(client.session.trace({ sessionID })).catch((error) => ({ error: String(error) })),
    unwrap<any[]>(client.session.children({ sessionID })).catch(() => []),
    unwrap<any>(client.session.filesystem.list({ sessionID })).catch((error) => ({ error: String(error) })),
    unwrap<any>(client.file.artifacts({ sessionID })).catch((error) => ({ error: String(error) })),
    unwrap<any>(client.provenance.executions({ sessionID })).catch((error) => ({ error: String(error) })),
  ])
  await Promise.all([
    writeAtomic(path.join(directory, "session.json"), safeValue(session)),
    writeAtomic(path.join(directory, "messages.observable.json"), observableMessages(messages)),
    writeAtomic(path.join(directory, "trace.json"), safeValue(trace)),
    writeAtomic(path.join(directory, "filesystem.json"), safeValue(filesystem)),
    writeAtomic(path.join(directory, "artifacts.json"), safeValue(discoveredArtifacts)),
    writeAtomic(path.join(directory, "children.json"), safeValue(children)),
    writeAtomic(path.join(directory, "executions.json"), safeValue(executions)),
  ])
  const descendants: CapturedSessionSource[] = []
  for (const child of children) {
    if (child?.id) descendants.push(...(await captureSessions(client, child.id, rawRoot, visited)))
  }
  return [{ sessionID, session, trace, executions }, ...descendants]
}

function finalText(message: Json | undefined) {
  return (message?.parts ?? [])
    .filter((part: Json) => part.type === "text")
    .map((part: Json) => String(part.text ?? ""))
    .filter(Boolean)
    .join("\n\n")
}

async function capturedEvents(file: string) {
  const raw = await Bun.file(file)
    .text()
    .catch(() => "")
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const event = JSON.parse(line)
      return event && typeof event === "object" ? [event as Json] : []
    } catch {
      return []
    }
  })
}

export function trajectory(trace: Json, runtimeEvents: Json[]) {
  const entries = [
    ...(trace.inference ?? []).map((item: Json) => ({
      id: item.messageID,
      kind: "inference",
      name: `${item.provider}/${item.model}`,
      status: item.error ? "failed" : item.completedAt ? "completed" : "running",
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      durationMs: item.durationMs,
      agent: item.agent,
    })),
    ...(trace.tools ?? []).map((item: Json) => ({
      id: item.id,
      kind: item.category ?? "tool",
      name: item.title ?? item.name,
      tool: item.name,
      status: item.status,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      durationMs: item.durationMs,
      inputHash: item.inputHash,
      inputKeys: item.inputKeys,
    })),
    ...(trace.approvals ?? []).map((item: Json) => ({
      id: item.id,
      kind: "approval",
      name: item.permission,
      status: item.reply ?? "pending",
      startedAt: item.requestedAt,
      completedAt: item.repliedAt,
    })),
    ...(trace.jobs ?? []).map((item: Json) => ({
      id: item.id,
      kind: "job",
      name: item.name,
      status: item.status,
      startedAt: item.startedAt ?? item.createdAt,
      completedAt: item.completedAt,
      durationMs: item.durationMs,
      target: item.target,
    })),
    ...runtimeEvents.map((item) => ({
      id: `runtime-${item.sequence}`,
      kind: "runtime",
      name: item.type,
      status: /failed/.test(item.type)
        ? "failed"
        : /cancelled/.test(item.type)
          ? "cancelled"
          : /completed/.test(item.type)
            ? "completed"
            : undefined,
      at: item.time,
      sequence: item.sequence,
    })),
  ]
  entries.sort(
    (left: Json, right: Json) => Number(left.startedAt ?? left.at ?? 0) - Number(right.startedAt ?? right.at ?? 0),
  )
  return { schemaVersion: 1, timeline: entries, artifacts: trace.artifacts ?? [] }
}

export function mergeFailures(...sources: unknown[][]) {
  const output: Json[] = []
  const seenIDs = new Set<string>()
  const seenFallbacks = new Set<string>()
  for (const item of sources.flat()) {
    const failure = item && typeof item === "object" ? (item as Json) : { message: String(item) }
    const id = typeof failure.id === "string" && failure.id ? failure.id : undefined
    const fallback = JSON.stringify([
      failure.kind ?? failure.type ?? failure.name,
      failure.message ?? failure.error?.message ?? failure.detail,
      failure.createdAt ?? failure.at ?? failure.time,
    ])
    if ((id && seenIDs.has(id)) || (!id && seenFallbacks.has(fallback))) continue
    if (id) seenIDs.add(id)
    seenFallbacks.add(fallback)
    output.push(failure)
  }
  return output
}

type RuntimeEventSource = {
  events(input: { sessionID: string; afterSequence?: number; signal?: AbortSignal }): AsyncIterable<Json>
  replay(input: { sessionID: string; afterSequence?: number }): Promise<{ events: Json[]; latestSequence: number }>
}

function waitForPoll(delayMs: number, signal: AbortSignal) {
  if (signal.aborted || delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

export async function collectRuntimeRun(input: {
  runtime: RuntimeEventSource
  sessionID: string
  runID: string
  afterSequence: number
  signal: AbortSignal
  pollIntervalMs?: number
  onEvent: (event: Json) => void | Promise<void>
}) {
  const seen = new Set<number>()
  let cursor = input.afterSequence
  let terminal: Json | undefined
  let streamError: string | undefined
  let recovered = false

  const accept = async (event: Json) => {
    if (event.runID !== input.runID) return
    const sequence = Number(event.sequence)
    if (Number.isFinite(sequence)) {
      if (seen.has(sequence)) return
      seen.add(sequence)
      cursor = Math.max(cursor, sequence)
    }
    await input.onEvent(event)
    if (["runtime.completed", "runtime.failed", "runtime.cancelled"].includes(event.type)) terminal = event
  }

  try {
    for await (const event of input.runtime.events({
      sessionID: input.sessionID,
      afterSequence: input.afterSequence,
      signal: input.signal,
    })) {
      await accept(event)
      if (terminal) return { terminal, streamError, recovered }
    }
  } catch (error) {
    if (!input.signal.aborted) streamError = scrub(error instanceof Error ? error.message : String(error))
  }

  // A public runtime stream can lose its cursor after enough events or a
  // client/proxy failure. The durable replay journal is authoritative, so poll
  // it until the same run reaches a terminal event instead of abandoning an
  // otherwise healthy research run and discarding its trajectory.
  while (!terminal && !input.signal.aborted) {
    let replay: { events: Json[]; latestSequence: number } | undefined
    try {
      replay = await input.runtime.replay({ sessionID: input.sessionID, afterSequence: cursor })
    } catch (error) {
      try {
        replay = await input.runtime.replay({ sessionID: input.sessionID })
        recovered = true
      } catch (fallbackError) {
        streamError ??= scrub(
          fallbackError instanceof Error
            ? fallbackError.message
            : error instanceof Error
              ? error.message
              : String(fallbackError),
        )
      }
    }
    for (const event of replay?.events ?? []) await accept(event)
    if (terminal) break
    await waitForPoll(input.pollIntervalMs ?? 1_000, input.signal)
  }
  if (terminal && streamError) recovered = true
  return { terminal, streamError, recovered }
}

async function copyArtifacts(
  client: ReturnType<typeof createOpenScienceClient>,
  runRoot: string,
  baseUrl: string,
  projectID: string,
) {
  const records = await unwrap<any[]>(client.file.artifactStore.list({ state: "active" })).catch(() => [])
  const directory = path.join(runRoot, "artifacts")
  await mkdir(directory, { recursive: true })
  const output: Json[] = []
  for (const record of records) {
    const filename = String(record.current?.filename ?? record.title ?? record.id).replace(/[^A-Za-z0-9._-]+/g, "_")
    const relative = path.join("artifacts", `${record.id}-${filename}`)
    const size = Number(record.current?.size ?? 0)
    const item = { ...(safeValue(record) as Json), path: relative, copied: false }
    if (size <= MAX_ARTIFACT_BYTES) {
      const response = await fetch(new URL(`/file/artifact-store/${encodeURIComponent(record.id)}/raw`, baseUrl), {
        headers: { "x-openscience-project": projectID },
      }).catch(() => undefined)
      if (response?.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength <= MAX_ARTIFACT_BYTES) {
          await Bun.write(path.join(runRoot, relative), bytes)
          Object.assign(item, { copied: true, bytes: bytes.byteLength, sha256: sha256(bytes) })
        }
      }
    }
    output.push(item)
  }
  return output
}

async function runOne(input: {
  campaignRoot: string
  batchID: string
  prompt: CampaignPrompt
  baseUrl: string
  model: string
  modelEffort: string
  researchEffort: "normal" | "ultra"
  timeoutMinutes: number
  harness: Json
  server: Json
}) {
  const runID = promptRunID(input.prompt)
  const runRoot = path.join(input.campaignRoot, "runs", runID)
  const existing = await Bun.file(path.join(runRoot, "run.json"))
    .json()
    .catch(() => undefined)
  if (["completed", "partial", "blocked", "inconclusive", "failed", "cancelled"].includes(String(existing?.status))) {
    console.log(`${input.prompt.id}: already ${existing.status}; preserving the existing trajectory`)
    return existing
  }
  const resume = resumeCheckpoint(existing)
  if (existing && !resume) {
    throw new Error(
      `${input.prompt.id} has a non-terminal run record without a resumable project/session/runtime checkpoint`,
    )
  }
  await mkdir(runRoot, { recursive: true })
  if (!resume) await writeAtomic(path.join(runRoot, "prompt.md"), `${input.prompt.text}\n`)
  const startedAt = String(existing?.startedAt ?? new Date().toISOString())
  const initial: Json = resume
    ? { ...existing, status: "running", resumedAt: new Date().toISOString() }
    : {
        schemaVersion: 1,
        runID,
        promptId: input.prompt.id,
        title: input.prompt.title,
        batchId: input.batchID,
        status: "running",
        startedAt,
        model: input.model,
        provider: input.model.split("/")[0],
        effort: input.researchEffort,
        modelEffort: input.modelEffort,
        harness: input.harness,
        server: input.server,
        promptHash: input.prompt.sha256,
      }
  if (!resume) await writeAtomic(path.join(runRoot, "run.json"), initial)
  const root = createOpenScienceClient({ baseUrl: input.baseUrl })
  let client: ReturnType<typeof createOpenScienceClient> | undefined
  let project: Json | undefined
  let session: Json | undefined
  let accepted: Json | undefined
  let terminal: Json | undefined
  let timedOut = false
  const events: Json[] = resume ? await capturedEvents(path.join(runRoot, "events.ndjson")) : []
  let firstObservableAt = events.find((event) => event.type !== "runtime.accepted")?.time as number | undefined
  let firstVisibleTextAt = events.find((event) => {
    const part = event.properties?.part as Json | undefined
    return event.type === "message.part.updated" && part?.type === "text" && String(part.text ?? "").trim()
  })?.time as number | undefined
  const capturedSequences = new Set(events.map((event) => Number(event.sequence)).filter(Number.isFinite))
  const failures: Json[] = []
  const warnings: Json[] = []
  const permissionAbort = new AbortController()
  try {
    let runtime: ReturnType<typeof createOpenScienceRuntime>
    let afterSequence: number
    if (resume) {
      project = { id: resume.projectId, name: resume.projectLabel }
      session = { id: resume.sessionId }
      accepted = { runID: resume.runtimeRunId, acceptedAt: resume.acceptedAt }
      afterSequence = resume.afterSequence
      client = createOpenScienceClient({ baseUrl: input.baseUrl, projectID: resume.projectId })
      runtime = createOpenScienceRuntime({ baseUrl: input.baseUrl, projectID: resume.projectId })
      const trust = await unwrap<any>(client.project.trust.get({ projectID: resume.projectId }))
      await unwrap(
        client.project.trust.update({ projectID: resume.projectId, body: { trusted: true, root: trust.root } }),
      )
    } else {
      const createdProject = await unwrap<any>(
        root.global.project.create({
          name: `Cadence harness · ${input.prompt.id} · ${input.prompt.title}`,
          sources: [],
        }),
      )
      project = createdProject
      client = createOpenScienceClient({ baseUrl: input.baseUrl, projectID: createdProject.id })
      runtime = createOpenScienceRuntime({ baseUrl: input.baseUrl, projectID: createdProject.id })
      const trust = await unwrap<any>(client.project.trust.get({ projectID: createdProject.id }))
      await unwrap(
        client.project.trust.update({ projectID: createdProject.id, body: { trusted: true, root: trust.root } }),
      )
      const currentConfig = await unwrap<any>(client.config.get())
      const agent = Object.fromEntries(
        ["research", "explore", "execute", "review"].map((name) => [
          name,
          {
            ...(currentConfig.agent?.[name] ?? {}),
            model: input.model,
            options: {
              ...(currentConfig.agent?.[name]?.options ?? {}),
              reasoningEffort: input.modelEffort,
              reasoningSummary: "auto",
            },
          },
        ]),
      )
      await unwrap<any>(
        client.config.update({
          config: {
            ...currentConfig,
            default_agent: "research",
            model: input.model,
            agent: { ...(currentConfig.agent ?? {}), ...agent },
            sandbox: { ...(currentConfig.sandbox ?? {}), enabled: true, network: "deny", onUnavailable: "error" },
            permission: {
              ...(currentConfig.permission ?? {}),
              question: "deny",
              external_directory: "deny",
              websearch: "ask",
              webfetch: "ask",
              network: "ask",
              mcp: "ask",
              environment_mutation: "ask",
              compute_job: "ask",
              modal: "deny",
              remote_compute: "deny",
            },
          },
        }),
      )
      const createdSession = await unwrap<any>(
        client.session.create({
          title: `${input.prompt.id} · ${input.prompt.title}`,
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        }),
      )
      session = createdSession
      const baseline = await runtime.replay({ sessionID: createdSession.id })
      const createdAccepted = await runtime.prompt({
        sessionID: createdSession.id,
        message: input.prompt.text,
        effort: input.researchEffort,
      })
      accepted = createdAccepted
      afterSequence = baseline.latestSequence
      Object.assign(initial, {
        projectId: createdProject.id,
        projectLabel: createdProject.name,
        sessionId: createdSession.id,
        runtimeRunId: createdAccepted.runID,
        runtimeAcceptedAt: createdAccepted.acceptedAt,
        runtimeAfterSequence: afterSequence,
      })
      await writeAtomic(path.join(runRoot, "run.json"), safeValue(initial))
    }
    if (!client || !project || !session || !accepted) throw new Error("Runtime checkpoint initialization failed")
    const sessionID = session.id
    const permissionsFile = path.join(runRoot, "permissions.ndjson")
    const pump = permissionPump(client, permissionsFile, permissionAbort.signal)
    const eventAbort = new AbortController()
    let abortRequest: Promise<unknown> | undefined
    let resolveAbortRequest: (() => void) | undefined
    const abortRequested = new Promise<void>((resolve) => {
      resolveAbortRequest = resolve
    })
    const timeoutMs = Math.max(1, input.timeoutMinutes * 60_000 - Math.max(0, Date.now() - Date.parse(startedAt)))
    const timeout = setTimeout(() => {
      timedOut = true
      permissionAbort.abort()
      eventAbort.abort()
      abortRequest = unwrap(
        client!.session.abort(
          { sessionID: session!.id },
          { headers: { "x-openscience-abort-source": "runner_timeout" } },
        ),
      ).catch(() => undefined)
      resolveAbortRequest?.()
    }, timeoutMs)
    try {
      const collected = await collectRuntimeRun({
        runtime,
        sessionID: session.id,
        runID: accepted.runID,
        afterSequence,
        signal: eventAbort.signal,
        async onEvent(event) {
          const sequence = Number(event.sequence)
          if (!capturedSequences.has(sequence)) {
            const observable = observableRuntimeEvent(event)
            events.push(observable)
            if (Number.isFinite(sequence)) capturedSequences.add(sequence)
            await appendFile(path.join(runRoot, "events.ndjson"), JSON.stringify(observable) + "\n", { mode: 0o600 })
          }
          if (event.type !== "runtime.accepted" && firstObservableAt === undefined) firstObservableAt = event.time
          if (event.type === "message.part.updated") {
            const part = event.properties?.part as Json | undefined
            if (part?.type === "text" && String(part.text ?? "").trim() && firstVisibleTextAt === undefined) {
              firstVisibleTextAt = event.time
            }
          }
        },
      })
      terminal = collected.terminal
      if (collected.streamError) {
        warnings.push({
          kind: "capture",
          message: collected.recovered
            ? `Runtime stream recovered from the durable replay journal: ${collected.streamError}`
            : `Runtime stream ended before a terminal event: ${collected.streamError}`,
        })
      }
    } finally {
      clearTimeout(timeout)
      eventAbort.abort()
      permissionAbort.abort()
      if (!timedOut) resolveAbortRequest?.()
      await abortRequested
      await settleCleanup([pump, abortRequest])
    }

    if (timedOut) failures.push({ kind: "runner", message: `Run exceeded ${input.timeoutMinutes} minutes` })
    const messageID = typeof terminal?.properties?.messageID === "string" ? terminal.properties.messageID : undefined
    if (terminal?.type === "runtime.failed") {
      failures.push({
        kind: "runtime",
        ...(messageID ? { id: messageID } : {}),
        message: String(terminal.properties?.message ?? "Runtime failed"),
        createdAt: terminal.time,
      })
    }
    const message = messageID
      ? await unwrap<any>(client.session.message({ sessionID: session.id, messageID })).catch(() => undefined)
      : undefined
    const final = finalText(message)
    await writeAtomic(path.join(runRoot, "final.md"), final ? `${final}\n` : "")
    const rootTrace = await unwrap<any>(client.session.trace({ sessionID })).catch((error) => ({
      error: String(error),
      summary: {},
    }))
    const capturedSessions = await captureSessions(client, sessionID, path.join(runRoot, "raw", "sessions"))
    const sessionIDs = capturedSessions.map((item) => item.sessionID).filter((item): item is string => Boolean(item))
    const rootCapture = capturedSessions.find((item) => item.sessionID === sessionID)
    const executions = rootCapture?.executions ?? { error: "Root execution capture was unavailable" }
    const treeMetrics = aggregateCapturedSessionTree(capturedSessions, sessionID)
    const usage = await unwrap<any>(client.settings.usage.get()).catch((error) => ({ error: String(error) }))
    const [artifacts, discovered, trustAfter] = await Promise.all([
      copyArtifacts(client, runRoot, input.baseUrl, project.id),
      unwrap<any>(client.file.artifacts({ sessionID: session.id })).catch(() => []),
      unwrap<any>(client.project.trust.get({ projectID: project.id })).catch(() => undefined),
    ])
    await Promise.all([
      writeAtomic(path.join(runRoot, "trace.json"), safeValue(rootTrace)),
      writeAtomic(path.join(runRoot, "trajectory.json"), trajectory(rootTrace, events)),
      writeAtomic(path.join(runRoot, "executions.json"), safeValue(executions)),
      writeAtomic(path.join(runRoot, "usage.json"), safeValue(usage)),
      writeAtomic(path.join(runRoot, "artifacts.json"), { store: artifacts, discovered: safeValue(discovered) }),
    ])
    const completedAt = new Date().toISOString()
    const acceptedAt = Number(accepted?.acceptedAt ?? Date.parse(startedAt))
    const userAborted = isUserCancellation(terminal, initial.cancellation)
    const outcome = campaignOutcome({
      timedOut,
      userAborted,
      terminalType: terminal?.type,
      terminalError: terminal?.properties?.message,
      assistantError: message?.info?.error,
      finalText: final,
      artifactCount: artifacts.length,
    })
    let mergedFailures = mergeFailures(failures, rootTrace.failures ?? [])
    const result: Json = {
      ...initial,
      status: outcome.status,
      outcomeReason: outcome.reason,
      runtimeStatus: terminal?.type,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      timeToFirstEventMs: firstObservableAt ? firstObservableAt - acceptedAt : undefined,
      timeToFirstOutputMs: firstVisibleTextAt ? firstVisibleTextAt - acceptedAt : undefined,
      setupToAcceptedMs: acceptedAt - Date.parse(startedAt),
      projectId: project.id,
      projectLabel: project.name,
      sessionId: session.id,
      sessionIds: sessionIDs,
      runtimeRunId: accepted?.runID,
      terminal: safeValue(terminal),
      cancellation: userAborted
        ? terminal?.type === "runtime.cancelled"
          ? {
              source: "user",
              evidence: "runtime.cancelled",
              sessionId: session.id,
              runtimeRunId: accepted.runID,
              at: new Date(Number(terminal.time)).toISOString(),
              ...(messageID ? { messageID } : {}),
            }
          : initial.cancellation
        : undefined,
      failureCount: Math.max(mergedFailures.length, Number(rootTrace.summary?.failureCount ?? 0)),
      failures: mergedFailures,
      warnings,
      metrics: {
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        timeToFirstEventMs: firstObservableAt ? firstObservableAt - acceptedAt : undefined,
        timeToFirstOutputMs: firstVisibleTextAt ? firstVisibleTextAt - acceptedAt : undefined,
        timeToFirstVisibleTextMs: firstVisibleTextAt ? firstVisibleTextAt - acceptedAt : undefined,
        setupToAcceptedMs: acceptedAt - Date.parse(startedAt),
        inferenceCalls: rootTrace.summary?.inferenceCalls,
        toolCalls: rootTrace.summary?.toolCalls,
        toolCallsPerInference: rootTrace.summary?.toolCallsPerInference,
        toolExecutionMs: rootTrace.summary?.toolExecutionMs,
        toolCriticalPathMs: rootTrace.summary?.toolCriticalPathMs,
        toolMaxConcurrency: rootTrace.summary?.toolMaxConcurrency,
        toolParallelism: rootTrace.summary?.toolParallelism,
        toolContractBytes: rootTrace.summary?.toolContractBytes,
        contractBytes: rootTrace.summary?.contractBytes,
        searches: rootTrace.summary?.searchCount,
        childAgents: rootTrace.summary?.childCount,
        retries: rootTrace.summary?.retryCount,
        failures: Math.max(mergedFailures.length, Number(rootTrace.summary?.failureCount ?? 0)),
        cost: usage.total?.cost ?? rootTrace.summary?.cost,
      },
      usage: {
        cost: usage.total?.cost ?? rootTrace.summary?.cost,
        tokens: usage.total?.tokens ?? rootTrace.summary?.tokens,
      },
      treeMetrics,
      artifacts: artifacts.map((item) => ({
        label: item.title ?? item.current?.filename ?? item.id,
        path: item.path,
        kind: item.current?.mimeType ?? item.kind,
        bytes: item.bytes ?? item.current?.size,
      })),
      capture: { eventCount: events.length, capturedSessions: sessionIDs.length, trust: trustAfter },
    }
    const trustRevoked = await unwrap(
      client.project.trust.update({ projectID: project.id, body: { trusted: false } }),
    ).catch((error) => {
      failures.push({ kind: "cleanup", message: `Could not revoke project trust: ${String(error)}` })
      return undefined
    })
    await unwrap(client.instance.dispose()).catch((error) => {
      failures.push({ kind: "cleanup", message: `Could not dispose project instance: ${String(error)}` })
    })
    mergedFailures = mergeFailures(failures, rootTrace.failures ?? [])
    result.failures = mergedFailures
    result.failureCount = Math.max(result.failures.length, Number(rootTrace.summary?.failureCount ?? 0))
    result.metrics.failures = result.failureCount
    result.capture.cleanupTrust = trustRevoked
    await writeAtomic(path.join(runRoot, "run.json"), safeValue(result))
    console.log(`${input.prompt.id}: ${result.status} in ${Math.round(result.durationMs / 1000)}s · ${project.id}`)
    return result
  } catch (error) {
    permissionAbort.abort()
    const completedAt = new Date().toISOString()
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    const result = {
      ...initial,
      status: "failed",
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      projectId: project?.id,
      sessionId: session?.id,
      runtimeRunId: accepted?.runID,
      failureCount: 1,
      failures: [{ kind: "runner", message: scrub(message) }],
    }
    if (client && project) {
      await unwrap(client.project.trust.update({ projectID: project.id, body: { trusted: false } })).catch((error) => {
        result.failures.push({ kind: "cleanup", message: `Could not revoke project trust: ${String(error)}` })
        result.failureCount += 1
      })
      await unwrap(client.instance.dispose()).catch((error) => {
        result.failures.push({ kind: "cleanup", message: `Could not dispose project instance: ${String(error)}` })
        result.failureCount += 1
      })
    }
    await writeAtomic(path.join(runRoot, "run.json"), safeValue(result))
    console.error(`${input.prompt.id}: failed: ${message}`)
    return result
  }
}

async function serverSnapshot(port: number) {
  const listeners = await command(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
  const pid = Number(listeners.stdout.trim().split(/\s+/)[0]) || undefined
  const processInfo = pid ? await command(["ps", "-p", String(pid), "-o", "pid=,ppid=,lstart=,command="]) : undefined
  return { port, pid, process: processInfo?.stdout.trim() }
}

export async function updateCampaignProgress(campaignRoot: string, prompts: CampaignPrompt[], patch: Json = {}) {
  const campaignFile = path.join(campaignRoot, "campaign.json")
  const campaign = await Bun.file(campaignFile)
    .json()
    .catch(() => ({}))
  const records = await Promise.all(
    prompts.map((prompt) =>
      Bun.file(path.join(campaignRoot, "runs", promptRunID(prompt), "run.json"))
        .json()
        .catch(() => undefined),
    ),
  )
  const terminal = records.filter((record) =>
    ["completed", "partial", "blocked", "inconclusive", "failed", "cancelled"].includes(String(record?.status)),
  )
  const completed = terminal.filter((record) => record?.status === "completed").length
  const partial = terminal.filter((record) => record?.status === "partial").length
  const blocked = terminal.filter((record) => record?.status === "blocked").length
  const inconclusive = terminal.filter((record) => record?.status === "inconclusive").length
  const failed = terminal.filter((record) => record?.status === "failed").length
  const cancelled = terminal.filter((record) => record?.status === "cancelled").length
  const running = records.filter((record) => record?.status === "running").length
  const allAttempted = terminal.length === prompts.length
  const now = new Date().toISOString()
  const next = {
    ...campaign,
    ...patch,
    schemaVersion: 1,
    status: allAttempted
      ? failed > 0
        ? "failed"
        : blocked > 0
          ? "blocked"
          : partial > 0
            ? "partial"
            : inconclusive > 0
              ? "partial"
              : cancelled > 0
                ? "cancelled"
                : "completed"
      : running > 0 || terminal.length > 0 || patch.status === "running"
        ? "running"
        : "pending",
    plannedPrompts: prompts.length,
    observedPrompts: records.filter(Boolean).length,
    attemptedPrompts: terminal.length,
    completedPrompts: completed,
    partialPrompts: partial,
    blockedPrompts: blocked,
    inconclusivePrompts: inconclusive,
    failedPrompts: failed,
    cancelledPrompts: cancelled,
    runningPrompts: running,
    updatedAt: now,
    ...(allAttempted ? { completedAt: campaign.completedAt ?? now } : {}),
  }
  await writeAtomic(campaignFile, safeValue(next))
  return next
}

async function main() {
  const input = flags(Bun.argv.slice(2))
  const batchIndex = Number(input.get("batch"))
  if (!Number.isInteger(batchIndex) || batchIndex < 1 || batchIndex > 7) {
    throw new Error("Usage: bun evals/cadence-harness/run.ts --batch <1-7> [--campaign path]")
  }
  const campaignRoot = path.resolve(String(input.get("campaign") ?? DEFAULT_CAMPAIGN))
  const baseUrl = String(input.get("base-url") ?? DEFAULT_BASE_URL)
  const model = String(input.get("model") ?? DEFAULT_MODEL)
  const modelEffort = String(input.get("model-effort") ?? DEFAULT_MODEL_EFFORT)
  const researchEffort = String(input.get("research-effort") ?? DEFAULT_RESEARCH_EFFORT)
  if (researchEffort !== "normal" && researchEffort !== "ultra")
    throw new Error("Research effort must be normal or ultra")
  const timeoutMinutes = Number(input.get("timeout-minutes") ?? DEFAULT_TIMEOUT_MINUTES)
  const corpus = JSON.parse(await readFile(path.join(campaignRoot, "prompts.json"), "utf8")) as {
    prompts: CampaignPrompt[]
  }
  const prompts = corpus.prompts.filter((prompt) => prompt.batchIndex === batchIndex)
  if (prompts.length !== (batchIndex === 7 ? 2 : 3))
    throw new Error(`Batch ${batchIndex} has ${prompts.length} prompts`)
  const repoRoot = path.resolve(import.meta.dir, "../..")
  const [harness, preflightResult, server] = await Promise.all([
    gitFingerprint(repoRoot),
    preflight(baseUrl, model),
    serverSnapshot(Number(new URL(baseUrl).port || 80)),
  ])
  const batchID = `batch-${String(batchIndex).padStart(2, "0")}`
  const batchRoot = path.join(campaignRoot, "batches", batchID)
  await mkdir(batchRoot, { recursive: true })
  const startedAt = new Date().toISOString()
  const modelKey = parseModelKey(model)
  await updateCampaignProgress(campaignRoot, corpus.prompts, {
    status: "running",
    startedAt:
      (
        await Bun.file(path.join(campaignRoot, "campaign.json"))
          .json()
          .catch(() => undefined)
      )?.startedAt ?? startedAt,
    model,
    provider: modelKey.providerID,
    effort: researchEffort,
    modelEffort,
    harnessRevision: harness.head,
  })
  await writeAtomic(path.join(batchRoot, "batch.json"), {
    schemaVersion: 1,
    id: batchID,
    index: batchIndex,
    title: `Prompts ${prompts[0]!.id}–${prompts.at(-1)!.id}`,
    status: "running",
    startedAt,
    runIds: prompts.map(promptRunID),
    promptIds: prompts.map((prompt) => prompt.id),
    harnessBefore: harness,
    preflight: safeValue(preflightResult),
    server,
  })
  const results = await Promise.allSettled(
    prompts.map((prompt) =>
      runOne({
        campaignRoot,
        batchID,
        prompt,
        baseUrl,
        model,
        modelEffort,
        researchEffort,
        timeoutMinutes,
        harness,
        server,
      }),
    ),
  )
  const completedAt = new Date().toISOString()
  const runResults = results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { promptId: prompts[index]!.id, status: "failed", failure: String(result.reason) },
  )
  const completedRuns = runResults.filter((result) => result.status === "completed").length
  const failedRuns = runResults.filter((result) => result.status === "failed").length
  const partialRuns = runResults.filter((result) => result.status === "partial").length
  const blockedRuns = runResults.filter((result) => result.status === "blocked").length
  const inconclusiveRuns = runResults.filter((result) => result.status === "inconclusive").length
  const cancelledRuns = runResults.filter((result) => result.status === "cancelled").length
  await writeAtomic(path.join(batchRoot, "batch.json"), {
    schemaVersion: 1,
    id: batchID,
    index: batchIndex,
    title: `Prompts ${prompts[0]!.id}–${prompts.at(-1)!.id}`,
    status:
      failedRuns > 0
        ? "failed"
        : blockedRuns > 0
          ? "blocked"
          : partialRuns > 0 || inconclusiveRuns > 0
            ? "partial"
            : cancelledRuns > 0
              ? "cancelled"
              : "completed",
    startedAt,
    completedAt,
    runIds: prompts.map(promptRunID),
    promptIds: prompts.map((prompt) => prompt.id),
    harnessBefore: harness,
    preflight: safeValue(preflightResult),
    server,
    outcomes: runResults.map((result) => ({
      promptId: result.promptId,
      status: result.status,
      durationMs: result.durationMs,
      failureCount: result.failureCount,
    })),
    completedRuns,
    partialRuns,
    blockedRuns,
    inconclusiveRuns,
    cancelledRuns,
    failedRuns,
  })
  await updateCampaignProgress(campaignRoot, corpus.prompts)
  console.log(
    `${batchID}: ${completedRuns}/${prompts.length} completed · ${partialRuns} partial · ${blockedRuns} blocked · ${inconclusiveRuns} inconclusive · ${cancelledRuns} cancelled · ${failedRuns} failed`,
  )
}

if (import.meta.main) await main()
