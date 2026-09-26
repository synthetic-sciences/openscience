import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { JobBroker } from "@/compute/job-broker"
import type { ComputeCapabilities } from "@/compute/capabilities"
import { ModalPlan } from "@/compute/modal/plan"
import { ModalUpload } from "@/compute/modal/upload"
import { Instance } from "@/project/instance"
import { ComputeAllowance } from "@/permission/allowance"
import { SessionFilesystem } from "@/session/filesystem"
import { Filesystem } from "@/util/filesystem"
import { Tool } from "./tool"
import { SessionWake } from "@/session/wake"
import { SessionPrompt } from "@/session/prompt"
import { Log } from "@/util/log"

const COMPUTE_ACTIONS = [
  "targets",
  "plan",
  "start",
  "list",
  "status",
  "wait",
  "logs",
  "artifacts",
  "cancel",
  "retry_delivery",
  "release",
] as const
type ComputeAction = (typeof COMPUTE_ACTIONS)[number]

const ACTION_DESCRIPTIONS = {
  targets: "Discover available local, saved SSH/scheduler, and Modal targets.",
  plan: "Preview an immutable compute plan without dispatching it.",
  start: "Create and dispatch a detached compute job after any required approval.",
  list: "List project-scoped compute jobs, optionally filtered by status.",
  status: "Inspect the latest state of one existing job.",
  wait: "Suspend until the job's state changes or it settles, or the timeout passes; log lines alone do not end the wait (read them with logs). A wait that reaches its timeout hands control back and the job wakes you when it ends, so wait once rather than polling.",
  logs: "Read lifecycle events and bounded command output for one existing job.",
  artifacts: "Inspect expected and delivered outputs for one existing job.",
  cancel: "Stop one live job after dedicated approval.",
  retry_delivery: "Retry delivery from retained Modal output without rerunning the command.",
  release: "Discard retained remote resources after dedicated approval.",
} satisfies Record<ComputeAction, string>

const ACTION_EXAMPLES = {
  targets: '{"action":"targets"}',
  plan: '{"action":"plan","name":"Environment probe","purpose":"Check the local runtime before starting work.","command":"python --version","target":{"kind":"local"}}',
  start:
    '{"action":"start","name":"Run analysis","purpose":"Produce the requested analysis output.","command":"python analysis.py","target":{"kind":"local"}}',
  list: '{"action":"list","limit":20}',
  status: '{"action":"status","job_id":"job_..."}',
  wait: '{"action":"wait","job_id":"job_...","seconds":600}',
  logs: '{"action":"logs","job_id":"job_...","bytes":64000}',
  artifacts: '{"action":"artifacts","job_id":"job_..."}',
  cancel: '{"action":"cancel","job_id":"job_..."}',
  retry_delivery: '{"action":"retry_delivery","job_id":"job_..."}',
  release: '{"action":"release","job_id":"job_..."}',
} satisfies Record<ComputeAction, string>

const ACTION_HELP = COMPUTE_ACTIONS.map(
  (value) => `- ${value}: ${ACTION_DESCRIPTIONS[value]} Example: ${ACTION_EXAMPLES[value]}`,
).join("\n")

function action<const Value extends ComputeAction>(value: Value) {
  return z.literal(value).describe(`${ACTION_DESCRIPTIONS[value]} Exact input: ${ACTION_EXAMPLES[value]}`)
}

const ComputeTarget = JobBroker.Target.describe(
  'Object: {"kind":"local"}, {"kind":"modal"}, or {"kind":"ssh","host_id":"saved-host-id"}; never a quoted JSON string.',
)
const ComputeWorkload = z
  .object({
    name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    command: z.string().trim().min(1).max(100_000),
    cwd: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .optional()
      .describe(
        'Directory the job runs in, relative to Session scratch or Project files, e.g. "autoresearch_churn" with command "python train.py". Uses the scratch copy when it exists, else snapshots the Project-files directory (never its root). Omit for the workspace root.',
      ),
    target: ComputeTarget,
    resources: JobBroker.Resources.optional(),
    modules: z.array(z.string().trim().min(1).max(240)).max(64).optional(),
    container: z.string().trim().min(1).max(2_000).optional(),
    artifacts: z
      .array(z.string().trim().min(1).max(2_000))
      .max(100)
      .optional()
      .describe("Output paths or globs, relative to cwd."),
    checkpoint: z.string().trim().min(1).max(2_000).optional().describe("Relative checkpoint path."),
    uploads: z
      .array(z.string().trim().min(1).max(2_000))
      .max(100)
      .optional()
      .describe(
        "Files to stage, relative to cwd; remote targets stage all of cwd by default, an empty array nothing. Swept files fit 100 MiB together; a file named by exact path (no glob) may be up to 2 GiB.",
      ),
    exclude_uploads: z.array(z.string().trim().min(1).max(2_000)).max(20).optional(),
    packages: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
    image: z.string().trim().min(1).max(2_000).optional(),
    gpu: z.string().trim().min(1).max(120).optional(),
    secret_refs: JobBroker.SecretRef.array()
      .max(8)
      .optional()
      .describe("Available reviewed Modal credential names; never values."),
  })
  .strict()

const ComputeJobActionParameters = z
  .discriminatedUnion("action", [
    z
      .object({ action: action("targets") })
      .strict()
      .describe(ACTION_EXAMPLES.targets),
    ComputeWorkload.extend({ action: action("plan") }).describe(ACTION_EXAMPLES.plan),
    ComputeWorkload.extend({ action: action("start") }).describe(ACTION_EXAMPLES.start),
    z
      .object({
        action: action("list"),
        status: JobBroker.Status.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict()
      .describe(ACTION_EXAMPLES.list),
    z
      .object({ action: action("status"), job_id: z.string().trim().min(1) })
      .strict()
      .describe(ACTION_EXAMPLES.status),
    z
      .object({
        action: action("wait"),
        job_id: z.string().trim().min(1),
        seconds: z.number().int().min(1).default(3_600),
      })
      .strict()
      .describe(ACTION_EXAMPLES.wait),
    z
      .object({
        action: action("logs"),
        job_id: z.string().trim().min(1),
        bytes: z.number().int().min(1).max(256_000).default(64_000),
      })
      .strict()
      .describe(ACTION_EXAMPLES.logs),
    z
      .object({ action: action("artifacts"), job_id: z.string().trim().min(1) })
      .strict()
      .describe(ACTION_EXAMPLES.artifacts),
    z
      .object({ action: action("cancel"), job_id: z.string().trim().min(1) })
      .strict()
      .describe(ACTION_EXAMPLES.cancel),
    z
      .object({ action: action("retry_delivery"), job_id: z.string().trim().min(1) })
      .strict()
      .describe(ACTION_EXAMPLES.retry_delivery),
    z
      .object({ action: action("release"), job_id: z.string().trim().min(1) })
      .strict()
      .describe(ACTION_EXAMPLES.release),
  ])
  .describe(`Select one action with the required action discriminator.\n${ACTION_HELP}`)

/**
 * Model-facing tool schemas must have an object at the JSON Schema root.
 * Strict OpenAI-compatible providers reject a top-level anyOf before the model
 * can make a tool call. Keep the conditional action contract as the runtime
 * validator while advertising one ordinary object with every possible field.
 */
export const ComputeJobParameters = z
  .object({
    action: z.enum(COMPUTE_ACTIONS).describe("Action to perform"),
    name: ComputeWorkload.shape.name.optional(),
    purpose: ComputeWorkload.shape.purpose.optional(),
    command: ComputeWorkload.shape.command.optional(),
    cwd: ComputeWorkload.shape.cwd,
    target: ComputeWorkload.shape.target.optional(),
    resources: ComputeWorkload.shape.resources,
    modules: ComputeWorkload.shape.modules,
    container: ComputeWorkload.shape.container,
    artifacts: ComputeWorkload.shape.artifacts,
    checkpoint: ComputeWorkload.shape.checkpoint,
    uploads: ComputeWorkload.shape.uploads,
    exclude_uploads: ComputeWorkload.shape.exclude_uploads,
    packages: ComputeWorkload.shape.packages,
    image: ComputeWorkload.shape.image,
    gpu: ComputeWorkload.shape.gpu,
    secret_refs: ComputeWorkload.shape.secret_refs,
    status: JobBroker.Status.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    job_id: z.string().trim().min(1).optional(),
    seconds: z.number().int().min(1).optional(),
    bytes: z.number().int().min(1).max(256_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = ComputeJobActionParameters.safeParse(value)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
    }
  })
  .describe(
    'Use the required "action" discriminator, for example {"action":"targets"}. Required shapes are in the tool description.',
  )

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function knownAction(value: unknown): value is ComputeAction {
  return typeof value === "string" && (COMPUTE_ACTIONS as readonly string[]).includes(value)
}

function normalizeInput(input: unknown): unknown {
  if (!record(input)) return input
  let output = input
  let changed = false
  const copy = () => {
    if (!changed) output = { ...input }
    changed = true
    return output
  }

  const operation = input.operation
  const selected = input.action
  if (knownAction(operation) && (selected === undefined || selected === operation)) {
    const normalized = copy()
    normalized.action = operation
    delete normalized.operation
  }

  const effective = changed ? output.action : selected
  const conflictingAction = knownAction(operation) && knownAction(selected) && operation !== selected
  if (knownAction(effective) && !conflictingAction) {
    const workload = [
      "action",
      "name",
      "purpose",
      "command",
      "cwd",
      "target",
      "resources",
      "modules",
      "container",
      "artifacts",
      "checkpoint",
      "uploads",
      "packages",
      "image",
      "gpu",
      "secret_refs",
      "exclude_uploads",
    ]
    const allowed: Record<ComputeAction, Set<string>> = {
      targets: new Set(["action"]),
      plan: new Set(workload),
      start: new Set(workload),
      list: new Set(["action", "status", "limit"]),
      status: new Set(["action", "job_id"]),
      wait: new Set(["action", "job_id", "seconds"]),
      logs: new Set(["action", "job_id", "bytes"]),
      artifacts: new Set(["action", "job_id"]),
      cancel: new Set(["action", "job_id"]),
      retry_delivery: new Set(["action", "job_id"]),
      release: new Set(["action", "job_id"]),
    }
    const normalized = copy()
    for (const key of Object.keys(normalized)) {
      if (!allowed[effective].has(key)) delete normalized[key]
    }
  }
  const target = record(output.target) ? output.target : undefined
  if ((effective === "plan" || effective === "start") && target?.kind === "modal") {
    const normalized = copy()
    // These are scheduler/container fields for local and SSH targets. Modal's
    // reviewed adapter is configured exclusively through image/packages/gpu;
    // models commonly fill every optional field, so discard inapplicable
    // placeholders rather than rejecting an otherwise valid Modal plan.
    delete normalized.modules
    delete normalized.container
    if (record(normalized.resources)) {
      const resources = { ...normalized.resources }
      delete resources.partition
      normalized.resources = resources
    }
  }
  if ((effective === "plan" || effective === "start") && typeof output.target === "string") {
    try {
      const target = ComputeTarget.safeParse(JSON.parse(output.target))
      if (target.success) copy().target = target.data
    } catch {
      // Keep invalid strings unchanged so canonical validation can explain the error.
    }
  }
  return output
}

function formatValidationError(error: z.ZodError, input: unknown) {
  const details = error.issues
    .map((issue) => `- ${issue.path.length ? issue.path.join(".") : "input"}: ${issue.message}`)
    .join("\n")
  const selected = record(input) && knownAction(input.action) ? input.action : undefined
  const examples = selected
    ? `Copy-ready ${selected} shape (replace placeholder values only):\n${ACTION_EXAMPLES[selected]}`
    : `Valid action values: ${COMPUTE_ACTIONS.join(", ")}\nCopy-ready action shapes:\n${ACTION_HELP}`

  return [
    "Invalid arguments for compute_job.",
    details,
    examples,
    'Use the field "action", not "operation". For plan/start, target must be a JSON object, not a quoted JSON string.',
    'Allowed targets: {"kind":"local"}, {"kind":"modal"}, or {"kind":"ssh","host_id":"saved-host-id"}.',
  ].join("\n\n")
}

type Input = z.infer<typeof ComputeJobActionParameters>
type Metadata = {
  compute_job: {
    action: Input["action"]
    count?: number
    job?: JobBroker.Job
    plan?: JobBroker.Plan
  }
  compute?: JobBroker.Plan & {
    name: string
    /** The time allowance offered beside a Modal job, and the one covering it. */
    allowance?: { proposed_minutes: number; covered_by?: string; used_minutes?: number }
  }
  job?: JobBroker.Job
}

const summary = (job: JobBroker.Job) => ({
  id: job.id,
  name: job.name,
  purpose: job.purpose,
  capability: job.capability,
  target: job.target_label,
  status: job.status,
  execution: job.lifecycle?.execution,
  delivery: job.lifecycle?.delivery,
  resource: job.lifecycle?.resource,
  recoverable: job.lifecycle?.recoverable ?? false,
  exit_code: job.exit_code,
  created_at: job.created_at,
  started_at: job.started_at,
  completed_at: job.completed_at,
  error: job.error,
  capture_error: job.capture_error,
  cleanup_error: job.cleanup_error,
  recovery_attempts: job.recovery_attempts,
  recovery_retry_at: job.recovery_retry_at,
  remote_id: job.remote_id,
  volume: job.modal?.volume,
})

const json = (value: unknown) => JSON.stringify(value, null, 2)

export type ResolvedOptions = JobBroker.Options & {
  projectDirectory: string
  workspace: string
  capabilities?: ComputeCapabilities.Target[]
}

/** Broker options for a session's compute, shared with the study driver. */
export async function computeOptions(sessionID: string, base?: JobBroker.Options): Promise<ResolvedOptions> {
  return options(sessionID, base)
}

async function options(sessionID: string, base?: JobBroker.Options): Promise<ResolvedOptions> {
  // Where the session's relative paths resolve, which is where its code is:
  // the lead's own scratch or project, and for a worker the lead's directory
  // it was given to work in. The worker's private scratch is not it: with
  // that as the compute workspace every worker's `start` was refused as
  // "Compute project does not match the session workspace", and workers
  // ran their long computations through the shell instead.
  const workspace = await SessionFilesystem.toolDirectory(sessionID)
  if (base) return { ...base, projectDirectory: base.projectDirectory ?? Instance.directory, workspace }
  const module = await import("@/server/routes/settings/compute")
  const settings = await module.ComputeSettings.get()
  const modal = settings.providers.find((item) => item.id === "modal")
  const resolveCredentials = modal?.enabled ? module.ComputeSettings.modalResolver() : undefined
  const resolveSecrets = module.ComputeSettings.secretResolver()
  const config = modal?.enabled ? await module.ComputeSettings.modalConfig() : undefined
  const capabilities = await module.ComputeSettings.capabilities()
  return {
    projectDirectory: Instance.directory,
    workspace,
    hosts: settings.ssh_hosts,
    modal: config,
    resolveCredentials,
    resolveSecrets,
    capabilities,
  }
}

type PreparedRequest = {
  value: JobBroker.Request
  staged?: string
}

const COMPUTE_STAGE_DISK_RESERVE_BYTES = 512 * 1024 * 1024
/** Written into a scratch copy this tool staged from Project files. Under
 * `.openscience`, so the upload policy never ships it. */
const STAGED_MARKER = ".openscience/staged.json"

async function directory(root: string, relative: string) {
  const target = path.resolve(root, relative)
  const canonical = await Filesystem.canonical(target)
  const info = canonical ? await fs.stat(canonical).catch(() => undefined) : undefined
  return { target, canonical, info }
}

/**
 * The working directory as the staging code wants it: relative to the two
 * roots. A model that just read a file by its full path names the job's
 * directory the same way; an absolute path inside Session scratch or Project
 * files is the same request as its relative form, so it is converted rather
 * than refused. The Project-files root itself has no relative form and is
 * refused with the directory to name instead.
 */
export async function relativeWorkingDirectory(input: {
  cwd: string
  projectDirectory: string
  workspace: string
}): Promise<string> {
  const hint =
    'Give the directory that holds the code, relative to Session scratch or Project files (for example cwd "autoresearch_churn" with command "python train.py"); when the code sits at the project root, copy the scripts it needs into a subdirectory and name that. No compute job was dispatched.'
  if (!path.isAbsolute(input.cwd)) {
    if (input.cwd.split(/[\\/]/).includes("..")) {
      throw new Error(`Compute working directory cannot contain '..': ${input.cwd}. ${hint}`)
    }
    return input.cwd
  }
  const target = (await Filesystem.canonical(input.cwd)) ?? path.resolve(input.cwd)
  for (const root of [input.workspace, input.projectDirectory]) {
    const canonical = await Filesystem.canonical(root)
    if (!canonical || !Filesystem.contains(canonical, target)) continue
    const relative = path.relative(canonical, target)
    // Jobs run in Session scratch, so its root is a working directory (in a
    // headless run it is the project itself, and the code is there). The
    // Project-files root has no relative form and is refused with the
    // directory to name instead.
    if (relative === "" && root === input.workspace) return "."
    if (relative === "") {
      throw new Error(`Compute working directory is the Project files root itself: ${input.cwd}. ${hint}`)
    }
    return relative
  }
  throw new Error(`Compute working directory is outside Session scratch and Project files: ${input.cwd}. ${hint}`)
}

async function stageProjectDirectory(input: {
  cwd: string
  projectDirectory: string
  workspace: string
  target: JobBroker.Target
  uploads?: string[]
  explicitUploads: boolean
  exclude?: readonly string[]
  /** Overlay the project's files even onto a scratch directory this tool did
   * not stage: a study's root under Project files is authoritative, and the
   * agent may have left a same-named directory in scratch. */
  refresh?: boolean
}): Promise<string | undefined> {
  if (path.isAbsolute(input.cwd) || input.cwd.split(/[\\/]/).includes("..")) {
    throw new Error(
      `Compute working directory must be relative to Session scratch and cannot contain '..': ${input.cwd}`,
    )
  }

  const [workspace, project] = await Promise.all([
    Filesystem.canonical(input.workspace),
    Filesystem.canonical(input.projectDirectory),
  ])
  if (!workspace) throw new Error("Session scratch is unavailable; no compute job was dispatched")
  if (!project) throw new Error("Project files are unavailable; no compute job was dispatched")

  const current = await directory(workspace, input.cwd)
  if (!current.canonical || !Filesystem.contains(workspace, current.canonical)) {
    throw new Error(`Compute working directory escaped Session scratch: ${input.cwd}`)
  }
  // A copy this tool staged earlier mirrors Project files as they were at
  // that dispatch. Refresh it from the project when the source is still
  // there, so the code a study just changed is the code the run gets; the
  // outputs earlier runs delivered into the copy stay. A directory the agent
  // made in scratch itself has no marker and is left alone.
  const staged = current.info?.isDirectory()
    ? input.refresh ||
      (await fs
        .stat(path.join(current.target, STAGED_MARKER))
        .then(() => true)
        .catch(() => false))
    : false
  if (current.info?.isDirectory() && !staged) return
  if (current.info && !current.info.isDirectory()) {
    throw new Error(`Compute working directory is not a directory in Session scratch: ${input.cwd}`)
  }

  const source = await directory(project, input.cwd)
  // Session scratch and Project files are one directory in a headless run
  // (`--workspace project`): the code is already where the job runs, and a
  // study's refresh has nothing to overlay.
  if (source.canonical && current.canonical === source.canonical) return
  if (staged && (!source.canonical || !source.info?.isDirectory())) return
  if (!source.canonical || !Filesystem.contains(project, source.canonical) || !source.info?.isDirectory()) {
    throw new Error(
      `Compute working directory "${input.cwd}" does not exist in Session scratch or Project files. ` +
        "Create it in Session scratch, use an existing Project-files relative directory, or omit cwd for the workspace root. " +
        "No compute job was dispatched.",
    )
  }
  if (input.target.kind === "local") {
    throw new Error(
      `Local compute working directory "${input.cwd}" exists only in Project files. ` +
        "Copy it into Session scratch before dispatch; automatic bounded snapshots are available for Modal and SSH only. " +
        "No compute job was dispatched.",
    )
  }

  const parent = await Filesystem.canonical(path.dirname(current.target))
  if (!parent || !Filesystem.contains(workspace, parent)) {
    throw new Error(`Compute working directory escaped Session scratch while staging: ${input.cwd}`)
  }

  const label = input.target.kind === "ssh" ? "SSH staging" : "Modal staging"
  const manifest = await ModalPlan.stagingFiles(source.canonical, input.uploads ?? [], label, {
    prefix:
      input.target.kind === "ssh" && input.cwd !== "."
        ? input.cwd.replaceAll("\\", "/").replace(/^\.\//, "")
        : undefined,
    denied: input.explicitUploads ? "error" : "skip",
    exclude: input.exclude,
  })
  const disk = await fs.statfs(workspace)
  const available = Math.min(disk.bavail * disk.bsize, Number.MAX_SAFE_INTEGER)
  if (!Number.isFinite(available) || available < 0) {
    throw new Error(`${label} disk capacity could not be represented safely; no compute job was dispatched`)
  }
  const capacity = Math.max(0, available - COMPUTE_STAGE_DISK_RESERVE_BYTES)
  if (manifest.bytes > capacity) {
    throw new Error(
      `${label} requires ${manifest.bytes} bytes but Session scratch has ${capacity} safe staging bytes available ` +
        `after preserving the ${COMPUTE_STAGE_DISK_RESERVE_BYTES}-byte host reserve. No compute job was dispatched.`,
    )
  }

  await fs.mkdir(path.dirname(current.target), { recursive: true, mode: 0o700 })
  const materializedParent = await Filesystem.canonical(path.dirname(current.target))
  if (!materializedParent || !Filesystem.contains(workspace, materializedParent)) {
    throw new Error(`Compute working directory escaped Session scratch while staging: ${input.cwd}`)
  }
  const temporary = await fs.mkdtemp(path.join(workspace, ".compute-stage-"))
  const snapshot = path.join(temporary, "snapshot")
  try {
    await fs.mkdir(snapshot, { recursive: true, mode: 0o700 })
    for (const file of manifest.files) {
      const target = path.resolve(snapshot, file.path)
      if (!Filesystem.contains(snapshot, target))
        throw new Error(`${label} destination escaped Session scratch: ${file.path}`)
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await ModalUpload.stage(file.canonical, target, { size: file.size, sha256: file.sha256 }, label)
    }
    await fs.mkdir(path.join(snapshot, path.dirname(STAGED_MARKER)), { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(snapshot, STAGED_MARKER),
      JSON.stringify({ source: source.canonical, at: new Date().toISOString() }),
    )
    if (staged) {
      // Overlay: the project's current files replace their copies, file by
      // file; whatever else the copy holds (delivered outputs) is kept.
      for (const file of [...manifest.files.map((item) => item.path), STAGED_MARKER]) {
        const target = path.resolve(current.target, file)
        if (!Filesystem.contains(current.target, target))
          throw new Error(`${label} destination escaped Session scratch: ${file}`)
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await fs.rename(path.resolve(snapshot, file), target)
      }
    } else {
      await fs.rename(snapshot, current.target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error
        const existing = await directory(workspace, input.cwd)
        if (
          !existing.canonical ||
          !Filesystem.contains(workspace, existing.canonical) ||
          !existing.info?.isDirectory()
        ) {
          throw error
        }
      })
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }

  const placed = await directory(workspace, input.cwd)
  if (!placed.canonical || !Filesystem.contains(workspace, placed.canonical) || !placed.info?.isDirectory()) {
    throw new Error(`OpenScience could not stage Project files into Session scratch: ${input.cwd}`)
  }
  return input.cwd
}

async function request(
  input: Extract<Input, { action: "plan" | "start" }>,
  sessionID: string,
  options: ResolvedOptions,
  capability?: JobBroker.CapabilityBinding,
  capabilityExecution?: JobBroker.CapabilityExecution,
  refresh = false,
): Promise<PreparedRequest> {
  const cwd = input.cwd
    ? await relativeWorkingDirectory({
        cwd: input.cwd,
        projectDirectory: options.projectDirectory,
        workspace: options.workspace,
      })
    : undefined
  // A path given from the project root for a file inside the cwd names the
  // same file: "autoresearch_churn/train.py" with cwd "autoresearch_churn" is
  // "train.py". Strip the prefix rather than upload nothing.
  const inside = (value: string) => {
    if (!cwd) return value
    const prefix = `${cwd.replaceAll("\\", "/").replace(/\/$/, "")}/`
    return value.startsWith(prefix) ? value.slice(prefix.length) : value
  }
  const explicitUploads = input.uploads?.map(inside)
  const uploads =
    explicitUploads ??
    (input.target.kind === "modal"
      ? ["**/*"]
      : input.target.kind === "ssh" && cwd
        ? [`${cwd.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")}/**/*`]
        : undefined)
  const staged = cwd
    ? await stageProjectDirectory({
        cwd,
        projectDirectory: options.projectDirectory,
        workspace: options.workspace,
        target: input.target,
        uploads,
        explicitUploads: input.uploads !== undefined,
        exclude: input.exclude_uploads,
        refresh,
      })
    : undefined
  return {
    value: {
      sessionID,
      capability,
      capability_execution: capabilityExecution,
      name: input.name,
      purpose: input.purpose,
      command: input.command,
      cwd,
      target: input.target,
      resources: input.resources,
      modules: input.modules,
      container: input.container,
      artifacts: input.artifacts?.map(inside),
      checkpoint: input.checkpoint,
      uploads,
      default_uploads: input.target.kind === "modal" && input.uploads === undefined,
      exclude_uploads: input.exclude_uploads,
      packages: input.packages,
      image: input.image,
      gpu: input.target.kind === "modal" ? (input.gpu ?? "none") : input.gpu,
      secret_refs: input.secret_refs,
    },
    staged,
  }
}

async function jobs(sessionID: string, base?: JobBroker.Options) {
  const resolved = await options(sessionID, base)
  return { resolved, jobs: await JobBroker.list(resolved) }
}

/** Edits (insert, delete, substitute) between two short strings. */
function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]!
}

/** The job an id names. A twelve-character random id is mis-copied about
 * once a run (a case flip, one hex digit off, a dropped character), and the
 * wait or the log read then never happened. An id that names no job resolves
 * to the one job it is unambiguously closest to, or to the one job with that
 * name; otherwise the error lists what exists instead of inviting another
 * guess. */
function resolve(id: string, jobs: JobBroker.Job[]) {
  const exact = jobs.find((item) => item.id === id)
  if (exact) return exact
  const wanted = id.trim().toLowerCase()
  const relaxed = jobs.find((item) => item.id.toLowerCase() === wanted)
  if (relaxed) return relaxed
  const named = jobs.filter((item) => item.name === id.trim())
  if (named.length === 1) return named[0]
  const near = jobs.filter((item) => distance(item.id.toLowerCase(), wanted) <= 2)
  if (near.length === 1) return near[0]
}

async function selected(id: string, sessionID: string, base?: JobBroker.Options) {
  const state = await jobs(sessionID, base)
  const job = resolve(id, state.jobs)
  if (!job) {
    const known = state.jobs
      .slice(-8)
      .map((item) => `${item.id} (${item.name}, ${item.status})`)
      .join("; ")
    throw new Error(
      `Compute job ${id} was not found in this project.${known ? ` Jobs in this project: ${known}.` : ""}`,
    )
  }
  return { ...state, job }
}

function artifacts(job: JobBroker.Job) {
  const files = [...(job.artifacts ?? []), ...(job.checkpoint ? [job.checkpoint] : [])]
  // Delivered paths are relative to the job's working directory, which for
  // an isolated session is scratch that dies with the conversation. Say
  // where that is and how to keep what matters, so the outputs are not
  // hunted for with globs and then left where they will be deleted.
  const root = job.cwd
  const inProject = !!root && Filesystem.contains(Instance.directory, root)
  return {
    job: summary(job),
    expected: [...(job.artifact_patterns ?? []), ...(job.checkpoint_path ? [job.checkpoint_path] : [])],
    delivered: files.filter((file, index) => files.findIndex((item) => item.path === file.path) === index),
    delivered_root: root,
    delivered_in: root ? (inProject ? "project files" : "session scratch") : undefined,
    keep: root
      ? inProject
        ? "These paths are under Project files and persist."
        : `These paths are relative to ${root}, session scratch that is deleted with the conversation. Keep results with the artifact tool (Results) or copy them into Project files with bash.`
      : undefined,
    capture_error: job.capture_error,
  }
}

const log = Log.create({ service: "tool.compute-job" })

/** A watcher is not a lease on the run: a job that never settles stops being
 * waited on after a day, and `status` still answers for it. */
const WAKE_LIMIT_MS = 24 * 60 * 60_000
/** How long a dispatch waits for its job before handing back a step. */
const settle = { graceMs: 30_000 }

/** A test's barrier for the dispatch grace; disabled outside tests. */
export function computeJobTesting(input: { settleGraceMs: number }) {
  if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("compute_job test hooks are disabled outside tests")
  const prior = settle.graceMs
  settle.graceMs = input.settleGraceMs
  return {
    [Symbol.dispose]() {
      settle.graceMs = prior
    },
  }
}
/** The tail of a job's output a settled report carries inline. */
const REPORT_TAIL_BYTES = 6_000

/** A settled job as the model needs it in one reading: the summary, the
 * tail of its command output, and what it delivered. */
async function settledReport(job: JobBroker.Job, options: JobBroker.Options) {
  const output = await JobBroker.log(job.id, { ...options, bytes: REPORT_TAIL_BYTES }).catch(() => "")
  const { job: _repeated, ...delivered } = artifacts(job)
  return {
    ...summary(job),
    output_tail: output || "No command output was captured.",
    ...delivered,
    note: "This is the job's final state. Its full output is one `logs` call away if the tail is not enough.",
  }
}

/** Jobs already being watched, so repeated waits arm one watcher each. */
const watched = new Set<string>()

/** Wait for a job to settle, detached from the turn that asked, then deliver
 * its outcome to the session as a synthetic message. Mirrors the background
 * worker path in `task.ts`: work that outlives its turn reports itself instead
 * of being polled for. */
async function armWake(
  ctx: { sessionID: string; messageID: string; agent: string; extra?: { [key: string]: any } },
  jobID: string,
  resolved: JobBroker.Options,
) {
  if (watched.has(jobID)) return true
  // Arming a wake never fails the wait it rides on: a call with no resolvable
  // turn behind it (a direct invocation, a test harness) simply keeps the
  // old behaviour of returning at the timeout.
  const origin = await SessionWake.origin({
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    agent: ctx.agent,
    variant: ctx.extra?.variant,
  }).catch(() => undefined)
  if (!origin) return false
  watched.add(jobID)
  SessionPrompt.detached(async () => {
    try {
      const job = await JobBroker.wait(jobID, { ...resolved, timeout: WAKE_LIMIT_MS })
      await SessionWake.deliver({
        ...origin,
        text: `Compute job ${job.id} (${job.name}) ended with status ${job.status}. Read its logs with compute_job logs and its outputs with compute_job artifacts before continuing.`,
        describe: `compute job ${jobID}`,
      })
    } catch (error) {
      // The wake is what a caller waits on, so a watcher that cannot report
      // the outcome still reports that: silence would leave a headless run
      // waiting for a turn that never comes.
      log.warn("a compute job could not wake its session", { jobID, error: `${error}` })
      await SessionWake.deliver({
        ...origin,
        text: `Compute job ${jobID} could not be watched to completion (${error instanceof Error ? error.message : String(error)}). Check it with compute_job status.`,
        describe: `compute job ${jobID}`,
      }).catch(() => undefined)
    } finally {
      watched.delete(jobID)
    }
  }).catch((error: unknown) => {
    watched.delete(jobID)
    log.warn("a compute job wake could not be started", { jobID, error: `${error}` })
  })
  return true
}

export function createComputeJobTool(base?: JobBroker.Options) {
  return Tool.define<typeof ComputeJobParameters, Metadata>("compute_job", {
    description: [
      "Detached local, SSH/scheduler, and Modal jobs; prefer Python/R for interactive work.",
      "Use targets to discover, plan to preview, start to dispatch, and wait instead of shell polling. A start that settles within 30 s returns the job's outcome, output tail and deliveries in that one step; a longer job wakes you when it ends. list/status/logs/artifacts inspect jobs; cancel, retry_delivery, and release manage them.",
      "plan/start require name, purpose, command, and target. Remote starts require scoped approval. Other job actions use job_id.",
      'Example: {"action":"start","name":"Analysis","purpose":"Produce results","command":"python analysis.py","target":{"kind":"local"}}.',
      'Use "action", never "operation"; target is an object, never a JSON string. Never call Modal SDK/CLI directly.',
    ].join("\n"),
    parameters: ComputeJobParameters,
    normalizeInput,
    formatValidationError,
    async execute(value, ctx) {
      const input: Input = ComputeJobActionParameters.parse(value)
      if (input.action === "targets") {
        const resolved = await options(ctx.sessionID, base)
        const output = {
          local: { kind: "local", label: "This computer", interactive: false },
          ssh: (resolved.hosts ?? []).map((host) => ({
            kind: "ssh",
            host_id: host.id,
            label: host.label,
            host: host.host,
            scheduler: host.scheduler,
            notes: host.notes,
            verified: Boolean(host.fingerprint && host.host_key),
          })),
          modal: {
            kind: "modal",
            configured: Boolean(resolved.modal && resolved.resolveCredentials),
            usage: {
              target: { kind: "modal" },
              staging:
                "cwd may name an existing relative directory in Session scratch or Project files. Project files are snapshotted into Session scratch before planning; Modal stages that cwd by default.",
              environment:
                "Omit image to use the configured Python image. If packages are set, a custom image must already provide python and pip; bare CUDA runtime images do not.",
              network:
                resolved.modal?.network === "unrestricted"
                  ? "Outbound network access is enabled for approved Modal jobs."
                  : "Outbound network access is blocked. Do not submit jobs that download packages, models, or repositories; enable it in Compute settings first.",
              outputs: "Write and declare relative artifact/checkpoint paths under the job workspace, not /tmp.",
              gpu: "Set gpu to a Modal GPU type (T4, L4, A10, L40S, A100, A100-80GB, H100, H200, B200; 'H100:2' for two), or none for CPU-only discovery. Modal may upgrade A100 to 80 GB and H100 to H200.",
            },
          },
          capabilities: resolved.capabilities,
          // One preflight answer instead of facts scattered over settings:
          // whether a job could run, download, and reach a model API.
          readiness: (() => {
            const configured = Boolean(resolved.modal && resolved.resolveCredentials)
            const network = resolved.modal?.network === "unrestricted"
            const secrets = (resolved.capabilities ?? []).find((target) => target.kind === "modal")?.secret_refs ?? []
            return {
              remote_compute_configured: configured,
              outbound_network: network ? "enabled" : "blocked",
              downloads_permitted: network,
              secret_refs_available: secrets,
              credential_forwarding:
                "Only the listed secret_refs can be placed in a job. Provider API keys saved for chat (OpenRouter, OpenAI, Anthropic, Google) are not forwarded; a job that must call a model API needs a key the user provides for it.",
              ready_to_execute: configured
                ? network
                  ? "yes"
                  : "only jobs that need no downloads and no network"
                : "no remote target; local jobs only",
            }
          })(),
        }
        return {
          title: "Compute targets",
          metadata: { compute_job: { action: input.action, count: 1 + output.ssh.length + 1 } },
          output: json(output),
        }
      }

      if (input.action === "plan" || input.action === "start") {
        const resolved = await options(ctx.sessionID, base)
        const capability = JobBroker.CapabilityBinding.safeParse(ctx.extra?.scientificCapability)
        const capabilityExecution = JobBroker.CapabilityExecution.safeParse(ctx.extra?.scientificCapabilityExecution)
        const prepared = await request(
          input,
          ctx.sessionID,
          resolved,
          capability.success ? capability.data : undefined,
          capabilityExecution.success ? capabilityExecution.data : undefined,
          ctx.extra?.studyStaging === "refresh",
        )
        const value = prepared.value
        const plan = await JobBroker.plan(value, resolved)
        const metadata: Metadata = {
          compute_job: { action: input.action, plan },
          compute: { ...plan, name: input.name },
        }
        if (input.action === "plan") {
          return {
            title: `Compute plan: ${input.name}`,
            metadata,
            output: [
              ...(prepared.staged
                ? [`Staged Project files/${prepared.staged} into Session scratch before planning.`, ""]
                : []),
              json(plan),
            ].join("\n"),
          }
        }

        // A study's runs share the approval its creation asked for; the
        // digest of each dispatched plan is still recorded on the job.
        const scope =
          plan.provider !== "local" && typeof ctx.extra?.studyApproval === "string"
            ? ctx.extra.studyApproval
            : undefined
        // Outside a study, a Modal job asks under a time allowance the person
        // granted earlier when its timeout still fits; otherwise it asks on
        // its exact plan and offers an allowance beside it, so the next job
        // in the same piece of work does not prompt again.
        const allowance =
          plan.provider === "modal" && !scope
            ? await ComputeAllowance.cover({
                sessionID: ctx.sessionID,
                timeoutMinutes: plan.timeout_minutes,
                jobs: await JobBroker.list(resolved).catch(() => []),
              })
            : undefined
        const proposed =
          plan.provider === "modal" && !scope ? ComputeAllowance.propose(plan.timeout_minutes) : undefined
        const approval = {
          ...metadata,
          compute: {
            ...metadata.compute,
            ...(proposed !== undefined
              ? {
                  allowance: {
                    proposed_minutes: proposed,
                    ...(allowance ? { covered_by: allowance.pattern, used_minutes: allowance.used } : {}),
                  },
                }
              : {}),
          },
        }
        ctx.metadata({ title: `Review ${plan.provider} job: ${input.name}`, metadata: approval })
        await ctx.ask({
          permission: plan.provider === "modal" ? "modal" : plan.provider === "ssh" ? "remote_compute" : "compute_job",
          patterns: [scope ?? allowance?.pattern ?? plan.digest],
          always:
            plan.provider === "local"
              ? []
              : scope
                ? [scope]
                : [plan.digest, ...(proposed !== undefined ? [ComputeAllowance.pattern(proposed)] : [])],
          metadata: approval,
        })
        const job = await JobBroker.start(
          { ...value, approval: plan.provider === "local" ? undefined : plan.digest },
          resolved,
        )
        const complete: Metadata = { ...metadata, compute_job: { action: input.action, plan, job }, job }
        ctx.metadata({ title: `Compute job: ${input.name}`, metadata: complete })
        // Most jobs finish in seconds, and the dispatch used to hand back a
        // step that said only "queued": the model then spent a wait, a logs
        // and an artifacts call on each — four round-trips, each re-sending
        // the whole context, for work a shell command returns in one. A job
        // that settles within the grace comes back with its output; one that
        // runs on wakes the session when it ends.
        const settled = await JobBroker.wait(job.id, { ...resolved, timeout: settle.graceMs, signal: ctx.abort }).catch(
          () => undefined,
        )
        const staged = prepared.staged ? `Staged Project files/${prepared.staged} into Session scratch. ` : ""
        if (settled) {
          return {
            title: `Compute job: ${input.name}`,
            metadata: { ...complete, job: settled },
            output: `${staged}${json(await settledReport(settled, resolved))}`,
          }
        }
        const woken = await armWake(ctx, job.id, resolved)
        return {
          title: `Compute job: ${input.name}`,
          metadata: complete,
          output: `${staged}Dispatched ${plan.provider} job ${job.id}. Status: ${job.status} after ${Math.round(settle.graceMs / 1000)} s.${
            woken
              ? " It will wake you with its outcome when it ends: continue with other work, or end your turn and the wake starts a new one. Use compute_job wait only if nothing else can proceed; do not poll with shell sleep."
              : " Use compute_job wait to suspend until it settles or your selected timeout; do not poll with shell sleep."
          }`,
        }
      }

      if (input.action === "list") {
        const state = await jobs(ctx.sessionID, base)
        const filtered = input.status ? state.jobs.filter((job) => job.status === input.status) : state.jobs
        const output = filtered.slice(0, input.limit).map(summary)
        return {
          title: "Compute jobs",
          metadata: { compute_job: { action: input.action, count: output.length } },
          output: output.length ? json(output) : "No matching compute jobs were found in this project.",
        }
      }

      const state = await selected(input.job_id, ctx.sessionID, base)
      if (input.action === "status") {
        return {
          title: `Compute job: ${state.job.name}`,
          metadata: { compute_job: { action: input.action, job: state.job } },
          output: json(summary(state.job)),
        }
      }
      if (input.action === "wait") {
        // A wait the person interrupts (a stop, a message that ends the turn)
        // is not a failure of the job, which keeps running where it is. Say
        // exactly that, with the job's state, instead of a bare abort that
        // left one agent unsure whether to dispatch the job a second time.
        const started = Date.now()
        const interrupted = await JobBroker.waitForChange(state.job.id, {
          ...state.resolved,
          timeout: input.seconds * 1_000,
          signal: ctx.abort,
          after: state.job,
        }).then(
          (value) => ({ result: value }),
          (error: unknown) => {
            if (!ctx.abort.aborted) throw error
            // No lookup here: the turn is ending and a late result must land
            // before its call is closed as aborted. The state at the start of
            // the wait is what is known.
            return { job: state.job, waited_ms: Date.now() - started }
          },
        )
        if (!("result" in interrupted)) {
          return {
            title: `Compute job: ${interrupted.job.name}`,
            metadata: { compute_job: { action: input.action, job: interrupted.job } },
            output: json({
              ...summary(interrupted.job),
              wait_interrupted: true,
              waited_ms: interrupted.waited_ms,
              note: `The wait was interrupted after ${Math.round(interrupted.waited_ms / 1000)} s; job ${interrupted.job.id} was ${interrupted.job.status} when the wait began and continues on ${interrupted.job.target_label}. Do not dispatch it again: check it with compute_job status or wait for it again.`,
            }),
          }
        }
        const result = interrupted.result
        // A wait that reaches its timeout used to hand back a step that said
        // nothing and invited another wait: 396 such calls across one campaign,
        // each re-sending the whole context. The job now wakes the session when
        // it settles, the same way a background worker does, so the model can
        // do other work or end its turn.
        const woken = result.timed_out ? await armWake(ctx, state.job.id, state.resolved) : false
        // A settled job's wait carries what the model would otherwise fetch
        // with two more calls: the output's tail and the delivered artifacts.
        const report = result.changed.includes("settled") ? await settledReport(result.job, state.resolved) : undefined
        return {
          title: `Compute job: ${result.job.name}`,
          metadata: { compute_job: { action: input.action, job: result.job } },
          output: json({
            ...(report ?? summary(result.job)),
            changed: result.changed,
            waited_ms: result.waited_ms,
            timed_out: result.timed_out,
            output_bytes: result.output_bytes,
            event_bytes: result.event_bytes,
            ...(woken
              ? {
                  will_wake: true,
                  note: `Job ${state.job.id} is still running and will wake you with its outcome when it ends. Do not wait for it again: continue with other work, or end your turn and the wake starts a new one.`,
                }
              : {}),
          }),
        }
      }
      if (input.action === "logs") {
        const [events, output] = await Promise.all([
          JobBroker.events(state.job.id, { ...state.resolved, bytes: input.bytes }),
          JobBroker.log(state.job.id, { ...state.resolved, bytes: input.bytes }),
        ])
        return {
          title: `Compute logs: ${state.job.name}`,
          metadata: { compute_job: { action: input.action, job: state.job } },
          output: [
            `Job: ${state.job.id} · ${state.job.status}`,
            "",
            "Lifecycle logs:",
            events || "No lifecycle logs were captured.",
            "",
            "Command output:",
            output || "No command output was captured.",
          ].join("\n"),
        }
      }
      if (input.action === "artifacts") {
        return {
          title: `Compute artifacts: ${state.job.name}`,
          metadata: { compute_job: { action: input.action, job: state.job } },
          output: json(artifacts(state.job)),
        }
      }

      await ctx.ask({
        permission: "compute_job",
        patterns: [`${input.action}:${state.job.id}`],
        always: [],
        metadata: {
          compute_job: {
            action: input.action,
            job: summary(state.job),
          },
        },
      })

      const resolved = await options(ctx.sessionID, base)
      const job =
        input.action === "cancel"
          ? await JobBroker.cancel(state.job.id, resolved)
          : input.action === "retry_delivery"
            ? await JobBroker.retry(state.job.id, resolved)
            : await JobBroker.release(state.job.id, resolved)
      return {
        title: `Compute job: ${job.name}`,
        metadata: { compute_job: { action: input.action, job } },
        output: json(summary(job)),
      }
    },
  })
}

export const ComputeJobTool = createComputeJobTool()
