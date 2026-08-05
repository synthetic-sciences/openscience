import z from "zod"
import { ComputeJobs } from "@/compute/jobs"
import { Tool } from "./tool"

export const ComputeJobParameters = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    status: ComputeJobs.Status.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({ action: z.literal("status"), job_id: z.string().trim().min(1) }),
  z.object({
    action: z.literal("logs"),
    job_id: z.string().trim().min(1),
    bytes: z.number().int().min(1).max(256_000).default(64_000),
  }),
  z.object({ action: z.literal("artifacts"), job_id: z.string().trim().min(1) }),
  z.object({ action: z.literal("cancel"), job_id: z.string().trim().min(1) }),
  z.object({ action: z.literal("retry_delivery"), job_id: z.string().trim().min(1) }),
  z.object({ action: z.literal("release"), job_id: z.string().trim().min(1) }),
])

type Input = z.infer<typeof ComputeJobParameters>
type Metadata = {
  compute_job: {
    action: Input["action"]
    count?: number
    job?: ComputeJobs.Job
  }
}

const summary = (job: ComputeJobs.Job) => ({
  id: job.id,
  name: job.name,
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

async function options(base?: ComputeJobs.Options): Promise<ComputeJobs.Options> {
  if (base) return base
  const module = await import("@/server/routes/settings/compute")
  const settings = await module.ComputeSettings.get()
  const modal = settings.providers.find((item) => item.id === "modal")
  const resolveCredentials = modal?.enabled ? module.ComputeSettings.modalResolver() : undefined
  return { hosts: settings.ssh_hosts, resolveCredentials }
}

async function jobs(base?: ComputeJobs.Options) {
  const resolved = await options(base)
  return { resolved, jobs: await ComputeJobs.list(resolved) }
}

async function selected(id: string, base?: ComputeJobs.Options) {
  const state = await jobs(base)
  const job = state.jobs.find((item) => item.id === id)
  if (!job) throw new Error(`Compute job ${id} was not found in this project`)
  return { ...state, job }
}

function artifacts(job: ComputeJobs.Job) {
  const files = [...(job.artifacts ?? []), ...(job.checkpoint ? [job.checkpoint] : [])]
  return {
    job: summary(job),
    expected: [...(job.artifact_patterns ?? []), ...(job.checkpoint_path ? [job.checkpoint_path] : [])],
    delivered: files.filter((file, index) => files.findIndex((item) => item.path === file.path) === index),
    capture_error: job.capture_error,
  }
}

export function createComputeJobTool(base?: ComputeJobs.Options) {
  return Tool.define<typeof ComputeJobParameters, Metadata>("compute_job", {
    description: [
      "Inspect and control project-scoped compute jobs through OpenScience's broker.",
      "Use list, status, logs, and artifacts for read-only checks; these never dispatch compute and never require paid-run approval.",
      "Use cancel to stop a live job, retry_delivery to harvest a retained Modal volume without rerunning the command, and release only when the user wants to discard retained remote resources.",
      "Never use a new modal dispatch to check an existing job. Never invoke the Modal SDK or CLI directly.",
    ].join("\n"),
    parameters: ComputeJobParameters,
    async execute(input: Input, ctx) {
      if (input.action === "list") {
        const state = await jobs(base)
        const filtered = input.status ? state.jobs.filter((job) => job.status === input.status) : state.jobs
        const output = filtered.slice(0, input.limit).map(summary)
        return {
          title: "Compute jobs",
          metadata: { compute_job: { action: input.action, count: output.length } },
          output: output.length ? json(output) : "No matching compute jobs were found in this project.",
        }
      }

      const state = await selected(input.job_id, base)
      if (input.action === "status") {
        return {
          title: `Compute job: ${state.job.name}`,
          metadata: { compute_job: { action: input.action, job: state.job } },
          output: json(summary(state.job)),
        }
      }
      if (input.action === "logs") {
        const [events, output] = await Promise.all([
          ComputeJobs.events(state.job.id, { ...state.resolved, bytes: input.bytes }),
          ComputeJobs.log(state.job.id, { ...state.resolved, bytes: input.bytes }),
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

      const resolved = await options(base)
      const job =
        input.action === "cancel"
          ? await ComputeJobs.cancel(state.job.id, resolved)
          : input.action === "retry_delivery"
            ? await ComputeJobs.retry(state.job.id, resolved)
            : await ComputeJobs.release(state.job.id, resolved)
      return {
        title: `Compute job: ${job.name}`,
        metadata: { compute_job: { action: input.action, job } },
        output: json(summary(job)),
      }
    },
  })
}

export const ComputeJobTool = createComputeJobTool()
