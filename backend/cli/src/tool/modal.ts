import z from "zod"
import { Tool } from "./tool"
import { JobBroker } from "@/compute/job-broker"
import { Instance } from "@/project/instance"
import { SessionFilesystem } from "@/session/filesystem"

export const ModalTool = Tool.define("modal", {
  description: [
    "Plan and dispatch a governed job through OpenScience's Modal control-plane adapter.",
    "Only use this tool after the user explicitly asks to run a workload on Modal; do not hand them values to copy into Compute and do not invoke the Modal CLI.",
    "When the requested files and parameters are ready, call this tool immediately. Do not first present a prose approval card or ask for chat confirmation; this tool's governed card is the approval request.",
    "Never use this tool to answer whether Modal is available, configured, connected, or enabled. Those are read-only capability questions, and enabling Modal is not permission to run a job.",
    "The tool presents the exact image, Python packages, command, files, resources, network policy, timeout, and paid-run warning for user approval before resolving credentials or dispatching.",
    "Every call must include timeout_minutes. Choose it from the expected workload duration with a reasonable safety margin; do not omit it or ask the user to choose unless they specified a time or spending constraint.",
    "List every local input in uploads. Put third-party Python dependencies in packages so they are installed into the reviewed image before the command runs.",
    "After dispatch, use the compute_job tool for later status, logs, artifacts, cancellation, or retained-output recovery; never dispatch another job merely to inspect this one.",
  ].join("\n"),
  parameters: z.object({
    name: z.string().trim().min(1).max(120).describe("Short job name shown in Compute."),
    purpose: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Expected scientific purpose and the result this paid job should produce."),
    command: z.string().trim().min(1).max(100_000).describe("Ordinary shell command executed inside the sandbox."),
    cwd: z.string().trim().min(1).optional().describe("Working directory relative to the session workspace."),
    uploads: z
      .array(z.string().trim().min(1).max(2_000))
      .max(100)
      .default([])
      .describe("Project-relative input file globs copied into the sandbox."),
    outputs: z
      .array(z.string().trim().min(1).max(2_000))
      .max(100)
      .default([])
      .describe("Project-relative output globs copied back after the run."),
    packages: z
      .array(z.string().trim().min(1).max(500))
      .max(100)
      .default([])
      .describe("Python package requirements installed into the approved image, preferably pinned."),
    image: z.string().trim().min(1).max(2_000).optional().describe("Optional container image override."),
    gpu: z.string().trim().min(1).max(120).default("none").describe("Modal GPU type, or none for CPU-only work."),
    cpus: z.number().int().min(1).max(1024).optional(),
    gpus: z.number().int().min(0).max(128).optional(),
    memory_gb: z.number().min(0.1).max(100_000).optional(),
    timeout_minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .describe("Required job limit chosen from the expected runtime plus a reasonable safety margin."),
    wait: z
      .boolean()
      .default(false)
      .describe(
        "Wait for completion and return the job log only when explicitly requested; dispatch returns immediately by default.",
      ),
  }),
  async execute(input, ctx) {
    // Kept dynamic because ComputeSettings currently owns both route handlers and
    // the trusted credential resolver. Credentials are intentionally resolved
    // only after the spend approval below.
    const settings = await import("@/server/routes/settings/compute")
    const config = await settings.ComputeSettings.modalConfig()
    const resources = {
      cpus: input.cpus,
      gpus: input.gpus,
      memory_gb: input.memory_gb,
      time_minutes: input.timeout_minutes,
    }
    const request = {
      name: input.name,
      purpose: input.purpose,
      command: input.command,
      cwd: input.cwd,
      target: { kind: "modal" as const },
      resources: Object.values(resources).some((value) => value !== undefined) ? resources : undefined,
      uploads: input.uploads,
      artifacts: input.outputs,
      packages: input.packages,
      image: input.image,
      gpu: input.gpu,
      sessionID: ctx.sessionID,
    }
    const broker = {
      projectDirectory: Instance.directory,
      workspace: await SessionFilesystem.workspace(ctx.sessionID),
      modal: config,
    }
    const plan = await JobBroker.plan(request, broker)
    if (plan.provider !== "modal") throw new Error("Modal approval returned a non-Modal plan")
    const metadata = { compute: { ...plan, name: input.name } }
    ctx.metadata({ title: `Review Modal job: ${input.name}`, metadata })
    await ctx.ask({
      permission: "modal",
      patterns: [plan.digest],
      always: [plan.digest],
      metadata,
    })

    const resolveCredentials = settings.ComputeSettings.modalResolver()
    const job = await JobBroker.start({ ...request, approval: plan.digest }, { ...broker, resolveCredentials })
    ctx.metadata({ title: `Modal job: ${input.name}`, metadata: { ...metadata, job } })
    if (!input.wait) {
      return {
        title: `Modal job: ${input.name}`,
        metadata: { ...metadata, job },
        output: `Dispatched Modal job ${job.id}. Status: ${job.status}. Track it in Compute → Jobs or inspect it later with compute_job.`,
      }
    }

    const finished = await JobBroker.wait(job.id, {
      ...broker,
      timeout: plan.timeout_minutes * 60_000 + 10 * 60_000,
    })
    const log = await JobBroker.log(job.id, broker)
    return {
      title: `Modal job: ${input.name}`,
      metadata: { ...metadata, job: finished },
      output: [`Modal job ${finished.id}: ${finished.status} (exit ${finished.exit_code ?? "unknown"})`, "", log].join(
        "\n",
      ),
    }
  },
})
