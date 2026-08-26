import z from "zod"
import path from "node:path"
import { JobBroker } from "@/compute/job-broker"
import type { ComputeCapabilities } from "@/compute/capabilities"
import { Instance } from "@/project/instance"
import { SessionFilesystem } from "@/session/filesystem"
import { Tool } from "./tool"

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
  wait: "Wait for meaningful job, output, delivery, or resource change without model-driven polling.",
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
      .describe("Existing relative workspace directory; create it first. Omit for the workspace root."),
    target: ComputeTarget,
    resources: JobBroker.Resources.optional(),
    modules: z.array(z.string().trim().min(1).max(240)).max(64).optional(),
    container: z.string().trim().min(1).max(2_000).optional(),
    artifacts: z
      .array(z.string().trim().min(1).max(2_000))
      .max(100)
      .optional()
      .describe("Relative output paths or globs."),
    checkpoint: z.string().trim().min(1).max(2_000).optional().describe("Relative checkpoint path."),
    uploads: z
      .array(z.string().trim().min(1).max(2_000))
      .max(100)
      .optional()
      .describe("Relative session files to stage."),
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
        seconds: z.number().int().min(1).default(600),
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
  if (
    (effective === "plan" || effective === "start") &&
    target?.kind === "modal" &&
    typeof output.cwd === "string" &&
    path.isAbsolute(output.cwd)
  ) {
    delete copy().cwd
  }
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
  compute?: JobBroker.Plan & { name: string }
  job?: JobBroker.Job
}

const summary = (job: JobBroker.Job) => ({
  id: job.id,
  name: job.name,
  purpose: job.purpose,
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

type ResolvedOptions = JobBroker.Options & { capabilities?: ComputeCapabilities.Target[] }

async function options(sessionID: string, base?: JobBroker.Options): Promise<ResolvedOptions> {
  const workspace = await SessionFilesystem.workspace(sessionID)
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

function request(input: Extract<Input, { action: "plan" | "start" }>, sessionID: string): JobBroker.Request {
  return {
    sessionID,
    name: input.name,
    purpose: input.purpose,
    command: input.command,
    cwd: input.cwd,
    target: input.target,
    resources: input.resources,
    modules: input.modules,
    container: input.container,
    artifacts: input.artifacts,
    checkpoint: input.checkpoint,
    uploads: input.uploads,
    packages: input.packages,
    image: input.image,
    gpu: input.target.kind === "modal" ? (input.gpu ?? "none") : input.gpu,
    secret_refs: input.secret_refs,
  }
}

async function jobs(sessionID: string, base?: JobBroker.Options) {
  const resolved = await options(sessionID, base)
  return { resolved, jobs: await JobBroker.list(resolved) }
}

async function selected(id: string, sessionID: string, base?: JobBroker.Options) {
  const state = await jobs(sessionID, base)
  const job = state.jobs.find((item) => item.id === id)
  if (!job) throw new Error(`Compute job ${id} was not found in this project`)
  return { ...state, job }
}

function artifacts(job: JobBroker.Job) {
  const files = [...(job.artifacts ?? []), ...(job.checkpoint ? [job.checkpoint] : [])]
  return {
    job: summary(job),
    expected: [...(job.artifact_patterns ?? []), ...(job.checkpoint_path ? [job.checkpoint_path] : [])],
    delivered: files.filter((file, index) => files.findIndex((item) => item.path === file.path) === index),
    capture_error: job.capture_error,
  }
}

export function createComputeJobTool(base?: JobBroker.Options) {
  return Tool.define<typeof ComputeJobParameters, Metadata>("compute_job", {
    description: [
      "Detached local, SSH/scheduler, and Modal jobs; prefer Python/R for interactive work.",
      "Use targets to discover, plan to preview, start to dispatch, and wait instead of shell polling. list/status/logs/artifacts inspect jobs; cancel, retry_delivery, and release manage them.",
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
              staging: "Omit cwd unless it names an existing relative directory in this session workspace.",
              environment:
                "Omit image to use the configured Python image. If packages are set, a custom image must already provide python and pip; bare CUDA runtime images do not.",
              network:
                resolved.modal?.network === "unrestricted"
                  ? "Outbound network access is enabled for approved Modal jobs."
                  : "Outbound network access is blocked. Do not submit jobs that download packages, models, or repositories; enable it in Compute settings first.",
              outputs: "Write and declare relative artifact/checkpoint paths under the job workspace, not /tmp.",
              gpu: "Set gpu to the exact Modal GPU request, or none for CPU-only discovery.",
            },
          },
          capabilities: resolved.capabilities,
        }
        return {
          title: "Compute targets",
          metadata: { compute_job: { action: input.action, count: 1 + output.ssh.length + 1 } },
          output: json(output),
        }
      }

      if (input.action === "plan" || input.action === "start") {
        const resolved = await options(ctx.sessionID, base)
        const value = request(input, ctx.sessionID)
        const plan = await JobBroker.plan(value, resolved)
        const metadata: Metadata = {
          compute_job: { action: input.action, plan },
          compute: { ...plan, name: input.name },
        }
        if (input.action === "plan") {
          return { title: `Compute plan: ${input.name}`, metadata, output: json(plan) }
        }

        ctx.metadata({ title: `Review ${plan.provider} job: ${input.name}`, metadata })
        await ctx.ask({
          permission: plan.provider === "modal" ? "modal" : plan.provider === "ssh" ? "remote_compute" : "compute_job",
          patterns: [plan.digest],
          always: plan.provider === "local" ? [] : [plan.digest],
          metadata,
        })
        const job = await JobBroker.start(
          { ...value, approval: plan.provider === "local" ? undefined : plan.digest },
          resolved,
        )
        const complete: Metadata = { ...metadata, compute_job: { action: input.action, plan, job }, job }
        ctx.metadata({ title: `Compute job: ${input.name}`, metadata: complete })
        return {
          title: `Compute job: ${input.name}`,
          metadata: complete,
          output: `Dispatched ${plan.provider} job ${job.id}. Status: ${job.status}. Use compute_job wait to suspend until meaningful progress, completion, or your selected timeout; do not poll with shell sleep.`,
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
        const result = await JobBroker.waitForChange(state.job.id, {
          ...state.resolved,
          timeout: input.seconds * 1_000,
          signal: ctx.abort,
          after: state.job,
        })
        return {
          title: `Compute job: ${result.job.name}`,
          metadata: { compute_job: { action: input.action, job: result.job } },
          output: json({
            ...summary(result.job),
            changed: result.changed,
            waited_ms: result.waited_ms,
            timed_out: result.timed_out,
            output_bytes: result.output_bytes,
            event_bytes: result.event_bytes,
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
