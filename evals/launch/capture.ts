import path from "node:path"
import { mkdir, readdir, realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { validateLaunchSuite } from "./validate"

type Artifact = {
  path: string
  type: string
  required: boolean
  openable: boolean
}

type Flow = {
  id: string
  split: "development" | "held_out"
  title: string
  artifacts: Artifact[]
  observe: string[]
  repeat: number
}

type Trace = {
  version: 1
  session: {
    id: string
    title: string
    status: "idle" | "retry" | "busy" | "compacting"
    createdAt: number
    updatedAt: number
  }
  summary: {
    timeToFirstUsefulOutputMs?: number
    totalCompletionTimeMs?: number
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    toolCalls: number
    childCount: number
    searchCount: number
    dedupeHits: number
    approvalCount: number
    artifactSaves: number
    failureCount: number
    retryCount: number
  }
  inference: Array<{
    model: string
    provider: string
    effort: string
    source: "managed" | "byok" | "chatgpt" | "local" | "oauth" | "unknown"
    cost: number
  }>
  tools: Array<{
    name: string
    category: string
    status: "pending" | "running" | "completed" | "error"
    durationMs?: number
    inputHash: string
  }>
  children: Array<{
    agent: string
    status: "pending" | "running" | "completed" | "error"
    toolCalls?: number
    failedToolCalls?: number
  }>
  searches: Array<{
    signature: string
    dedupeHit: boolean
    status: "pending" | "running" | "completed" | "error"
  }>
  kernels: Array<{
    language: "python" | "r"
    status: "pending" | "running" | "completed" | "error"
    executionCount?: number
  }>
  jobs: Array<{
    target: "local" | "ssh"
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"
    durationMs?: number
    artifactCount: number
  }>
  approvals: Array<{
    permission: string
    patterns: string[]
    reply?: "once" | "session" | "project" | "always" | "reject"
  }>
  external: Array<{
    kind: "model" | "api" | "compute"
    name: string
    source: string
    external: boolean
    cost?: number
  }>
  artifacts: unknown[]
  failures: unknown[]
  retries: unknown[]
  privacy: {
    local: true
    atlasRequired: false
    hiddenReasoningStored: false
    toolOutputsCopied: false
  }
}

type CapturedArtifact = {
  path: string
  type: string
  required: boolean
  exists: boolean
  valid: boolean
  sha256?: string
  bytes?: number
  savedAs?: string
}

type Result = {
  schemaVersion: 1
  suiteVersion: string
  suiteHash: string
  runID: string
  flowID: string
  split: "development" | "held_out"
  attempt: number
  phase: "baseline" | "development" | "held_out" | "release"
  capturedAt: string
  session: {
    id: string
    title: string
    status: string
    server?: string
    directory?: string
  }
  observables: ReturnType<typeof observables>
  artifacts: CapturedArtifact[]
  completion: {
    observableComplete: boolean
    requiresHumanReview: true
  }
  evidence: {
    trace: "trace.json"
    review: "review.json"
    artifacts: "artifacts"
  }
}

type CaptureOptions = {
  root: string
  flow: Flow
  suiteVersion: string
  suiteHash: string
  dimensions: string[]
  gates: string[]
  trace: Trace
  attempt: number
  phase: Result["phase"]
  runID: string
  artifactRoot?: string
  server?: string
  directory?: string
}

const dir = fileURLToPath(new URL(".", import.meta.url))
const hash = (value: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const totalTokens = (trace: Trace) =>
  trace.summary.tokens.input +
  trace.summary.tokens.output +
  trace.summary.tokens.reasoning +
  trace.summary.tokens.cache.read +
  trace.summary.tokens.cache.write

function observables(trace: Trace) {
  const unique = new Set(trace.searches.map((search) => search.signature)).size
  const tools = trace.tools.filter((tool) => tool.category === "tool")
  const kernels = trace.kernels.filter((kernel) => kernel.status === "completed")
  const jobs = trace.jobs.filter((job) => job.status === "succeeded")
  const costs = {
    model: trace.external.filter((item) => item.kind === "model").reduce((sum, item) => sum + (item.cost ?? 0), 0),
    api: trace.external.filter((item) => item.kind === "api").reduce((sum, item) => sum + (item.cost ?? 0), 0),
    compute: trace.external.filter((item) => item.kind === "compute").reduce((sum, item) => sum + (item.cost ?? 0), 0),
  }
  return {
    timeToFirstOutputMs: trace.summary.timeToFirstUsefulOutputMs,
    completionTimeMs: trace.summary.totalCompletionTimeMs,
    approvals: {
      total: trace.approvals.length,
      denied: trace.approvals.filter((approval) => approval.reply === "reject").length,
      unresolved: trace.approvals.filter((approval) => !approval.reply).length,
      scopes: trace.approvals.map((approval) => ({
        permission: approval.permission,
        patterns: approval.patterns,
        reply: approval.reply,
      })),
    },
    tools: {
      total: tools.length,
      succeeded: tools.filter((tool) => tool.status === "completed").length,
      failed: tools.filter((tool) => tool.status === "error").length,
    },
    kernels: {
      total: trace.kernels.length,
      succeeded: kernels.length,
      failed: trace.kernels.filter((kernel) => kernel.status === "error").length,
      languages: [...new Set(trace.kernels.map((kernel) => kernel.language))],
    },
    jobs: {
      total: trace.jobs.length,
      succeeded: jobs.length,
      failed: trace.jobs.filter((job) => job.status === "failed").length,
      ssh: trace.jobs.filter((job) => job.target === "ssh").length,
    },
    searches: {
      total: trace.searches.length,
      unique,
      duplicates: Math.max(0, trace.searches.length - unique),
      reused: trace.searches.filter((search) => search.dedupeHit).length,
      failed: trace.searches.filter((search) => search.status === "error").length,
    },
    children: {
      total: trace.children.length,
      failed: trace.children.filter((child) => child.status === "error").length,
    },
    failures: trace.summary.failureCount,
    retries: trace.summary.retryCount,
    cost: {
      total: trace.summary.cost,
      ...costs,
    },
    tokens: {
      total: totalTokens(trace),
      ...trace.summary.tokens,
    },
    privacy: trace.privacy,
  }
}

async function validArtifact(file: string, type: string) {
  const data = new Uint8Array(await Bun.file(file).arrayBuffer())
  if (data.byteLength === 0) return false
  if (type === "image") {
    return (
      data.byteLength >= 8 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47 &&
      data[4] === 0x0d &&
      data[5] === 0x0a &&
      data[6] === 0x1a &&
      data[7] === 0x0a
    )
  }
  const text = new TextDecoder().decode(data).trim()
  if (type === "json")
    return Bun.file(file)
      .json()
      .then(
        () => true,
        () => false,
      )
  if (type === "csv") return text.split(/\r?\n/).filter(Boolean).length >= 2
  return text.length > 0
}

async function captureArtifacts(root: string, output: string, artifacts: Artifact[]) {
  if (artifacts.length === 0) return []
  const directory = await stat(root).catch(() => undefined)
  if (!directory?.isDirectory()) throw new Error(`Artifact root does not exist: ${root}`)
  const base = await realpath(root)
  const target = path.join(output, "artifacts")
  await mkdir(target, { recursive: true })

  return Promise.all(
    artifacts.map(async (artifact): Promise<CapturedArtifact> => {
      const source = path.resolve(base, artifact.path)
      if (!source.startsWith(base + path.sep)) throw new Error(`Artifact escapes its root: ${artifact.path}`)
      if (!(await Bun.file(source).exists())) {
        return {
          path: artifact.path,
          type: artifact.type,
          required: artifact.required,
          exists: false,
          valid: false,
        }
      }
      const real = await realpath(source)
      if (!real.startsWith(base + path.sep)) throw new Error(`Artifact resolves outside its root: ${artifact.path}`)
      const data = new Uint8Array(await Bun.file(real).arrayBuffer())
      const savedAs = path.join("artifacts", artifact.path)
      const destination = path.join(output, savedAs)
      await mkdir(path.dirname(destination), { recursive: true })
      await Bun.write(destination, data)
      return {
        path: artifact.path,
        type: artifact.type,
        required: artifact.required,
        exists: true,
        valid: await validArtifact(destination, artifact.type),
        sha256: hash(data),
        bytes: data.byteLength,
        savedAs,
      }
    }),
  )
}

export async function captureRun(options: CaptureOptions) {
  if (options.attempt < 1 || options.attempt > options.flow.repeat) {
    throw new Error(`${options.flow.id} allows attempts 1–${options.flow.repeat}, received ${options.attempt}`)
  }
  if (options.phase === "development" && options.flow.split === "held_out") {
    throw new Error(`Held-out flow ${options.flow.id} cannot run during development tuning`)
  }
  if (
    !options.trace.privacy.local ||
    options.trace.privacy.atlasRequired ||
    options.trace.privacy.hiddenReasoningStored ||
    options.trace.privacy.toolOutputsCopied
  ) {
    throw new Error("Trace privacy contract is not launch-safe")
  }

  const output = path.resolve(options.root, options.runID)
  if (!output.startsWith(path.resolve(options.root) + path.sep)) throw new Error("Run ID escapes the results root")
  if (await Bun.file(path.join(output, "result.json")).exists()) throw new Error(`Run already exists: ${options.runID}`)
  await mkdir(output, { recursive: true })
  await Bun.write(path.join(output, "trace.json"), json(options.trace))

  const artifacts = options.flow.artifacts.length
    ? await captureArtifacts(options.artifactRoot ?? "", output, options.flow.artifacts)
    : []
  const complete =
    options.trace.session.status === "idle" &&
    options.trace.summary.failureCount === 0 &&
    artifacts.every((artifact) => !artifact.required || (artifact.exists && artifact.valid))
  const result: Result = {
    schemaVersion: 1,
    suiteVersion: options.suiteVersion,
    suiteHash: options.suiteHash,
    runID: options.runID,
    flowID: options.flow.id,
    split: options.flow.split,
    attempt: options.attempt,
    phase: options.phase,
    capturedAt: new Date().toISOString(),
    session: {
      id: options.trace.session.id,
      title: options.trace.session.title,
      status: options.trace.session.status,
      server: options.server,
      directory: options.directory,
    },
    observables: observables(options.trace),
    artifacts,
    completion: {
      observableComplete: complete,
      requiresHumanReview: true,
    },
    evidence: {
      trace: "trace.json",
      review: "review.json",
      artifacts: "artifacts",
    },
  }
  const review = {
    schemaVersion: 1,
    runID: options.runID,
    instructions:
      "Score only visible outputs, actions, approvals, artifacts, and timing. Never infer hidden reasoning. Use null until reviewed.",
    dimensions: Object.fromEntries(
      options.dimensions.map((id) => [id, { score: null as null | 0 | 1 | 2, evidence: "" }]),
    ),
    hardGates: Object.fromEntries(
      options.gates.map((id) => [id, { status: "not_evaluated" as "not_evaluated" | "pass" | "fail", evidence: "" }]),
    ),
    manual: {
      planUseful: null,
      citationSupport: null,
      artifactOpenChecks: null,
      uiResetCount: null,
      irrelevantToolCalls: null,
      unsupportedClaims: null,
      notes: "",
    },
  }
  await Promise.all([
    Bun.write(path.join(output, "result.json"), json(result)),
    Bun.write(path.join(output, "review.json"), json(review)),
  ])
  return { output, result }
}

export function summarize(results: Result[]) {
  const complete = results.filter((result) => result.completion.observableComplete).length
  const timings = results
    .map((result) => result.observables.completionTimeMs)
    .filter((value): value is number => typeof value === "number")
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runs: results.length,
    flows: new Set(results.map((result) => result.flowID)).size,
    observableComplete: complete,
    observableCompletionRate: results.length ? complete / results.length : 0,
    totalCost: results.reduce((sum, result) => sum + result.observables.cost.total, 0),
    totalTokens: results.reduce((sum, result) => sum + result.observables.tokens.total, 0),
    medianCompletionTimeMs: timings.length
      ? timings.toSorted((a, b) => a - b)[Math.floor(timings.length / 2)]
      : undefined,
    failures: results.reduce((sum, result) => sum + result.observables.failures, 0),
    retries: results.reduce((sum, result) => sum + result.observables.retries, 0),
    children: results.reduce((sum, result) => sum + result.observables.children.total, 0),
    duplicateSearches: results.reduce((sum, result) => sum + result.observables.searches.duplicates, 0),
    results: results.map((result) => ({
      runID: result.runID,
      flowID: result.flowID,
      split: result.split,
      attempt: result.attempt,
      observableComplete: result.completion.observableComplete,
      completionTimeMs: result.observables.completionTimeMs,
      cost: result.observables.cost.total,
      failures: result.observables.failures,
    })),
  }
}

function options(tokens: string[]) {
  return tokens.reduce<Record<string, string | true>>((result, token, index) => {
    if (!token.startsWith("--")) return result
    const key = token.slice(2)
    const next = tokens[index + 1]
    result[key] = next && !next.startsWith("--") ? next : true
    return result
  }, {})
}

async function fetchTrace(server: string, session: string, directory?: string, username?: string, password?: string) {
  const url = new URL(`/session/${encodeURIComponent(session)}/trace`, server)
  if (directory) url.searchParams.set("directory", directory)
  const headers = new Headers()
  if (username && password) {
    headers.set("authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
  }
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Trace request failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as Trace
}

async function main() {
  const command = Bun.argv[2]
  const flags = options(Bun.argv.slice(3))
  const validation = await validateLaunchSuite()
  if (validation.errors.length) throw new Error(validation.errors.join("\n"))
  const runs = path.resolve(typeof flags.output === "string" ? flags.output : path.join(dir, "runs"))

  if (command === "capture") {
    const id = typeof flags.flow === "string" ? flags.flow : ""
    const flow = validation.suite.flows.find((item) => item.id === id) as Flow | undefined
    if (!flow) throw new Error(`Unknown launch flow: ${id || "(missing --flow)"}`)
    const attempt = Number(typeof flags.attempt === "string" ? flags.attempt : "1")
    const phase = (typeof flags.phase === "string" ? flags.phase : "baseline") as Result["phase"]
    if (!["baseline", "development", "held_out", "release"].includes(phase)) throw new Error(`Unknown phase: ${phase}`)
    const session = typeof flags.session === "string" ? flags.session : ""
    const server = typeof flags.server === "string" ? flags.server : ""
    const traceFile = typeof flags["trace-file"] === "string" ? path.resolve(flags["trace-file"]) : undefined
    if (!traceFile && (!session || !server)) {
      throw new Error("Capture requires --trace-file or both --server and --session")
    }
    const trace = traceFile
      ? (JSON.parse(await Bun.file(traceFile).text()) as Trace)
      : await fetchTrace(
          server,
          session,
          typeof flags.directory === "string" ? flags.directory : undefined,
          typeof flags.username === "string" ? flags.username : undefined,
          typeof flags.password === "string" ? flags.password : undefined,
        )
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "")
    const runID = typeof flags["run-id"] === "string" ? flags["run-id"] : `${stamp}-${flow.id}-a${attempt}`
    const result = await captureRun({
      root: runs,
      flow,
      suiteVersion: validation.suite.version,
      suiteHash: validation.hash,
      dimensions: validation.rubric.dimensions.map((dimension) => dimension.id),
      gates: validation.rubric.hardGates.map((gate) => gate.id),
      trace,
      attempt,
      phase,
      runID,
      artifactRoot: typeof flags["artifact-root"] === "string" ? flags["artifact-root"] : undefined,
      server: server || undefined,
      directory: typeof flags.directory === "string" ? flags.directory : undefined,
    })
    console.log(`Captured ${flow.id} attempt ${attempt} → ${result.output}`)
    console.log(
      `observable=${result.result.completion.observableComplete ? "complete" : "incomplete"} · ${result.result.observables.completionTimeMs ?? "—"}ms · $${result.result.observables.cost.total.toFixed(4)}`,
    )
    return
  }

  if (command === "summary") {
    await mkdir(runs, { recursive: true })
    const entries = await readdir(runs, { withFileTypes: true })
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => Bun.file(path.join(runs, entry.name, "result.json")))
        .map(async (file) => ((await file.exists()) ? file : undefined)),
    )
    const results = await Promise.all(
      files.filter((file) => file !== undefined).map(async (file) => JSON.parse(await file.text()) as Result),
    )
    const summary = summarize(results)
    await Bun.write(path.join(runs, "summary.json"), json(summary))
    console.log(
      `${summary.observableComplete}/${summary.runs} observable-complete across ${summary.flows} flows · $${summary.totalCost.toFixed(4)} · ${summary.totalTokens} tokens`,
    )
    return
  }

  throw new Error("Usage: capture.ts capture --flow <id> (--trace-file <path> | --server <url> --session <id>)")
}

if (import.meta.main) await main()
