import type { Agent } from "@/agent/agent"
import { JobBroker } from "@/compute/job-broker"
import { Identifier } from "@/id/id"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"
import { ScientificCapabilityTool } from "@/tool/scientific-capability"
import type { Tool } from "@/tool/tool"

const terminal = new Set<JobBroker.Status>(["succeeded", "failed", "cancelled", "interrupted"])

type CapabilityTool = Awaited<ReturnType<typeof ScientificCapabilityTool.init>>
type Execution = Awaited<ReturnType<CapabilityTool["execute"]>>

function job(result: Execution) {
  const metadata = result.metadata as Record<string, unknown>
  const compute = metadata.compute_job as { job?: unknown } | undefined
  return JobBroker.Job.parse(compute?.job)
}

function parsedOutput(result: Execution) {
  try {
    return JSON.parse(result.output) as unknown
  } catch {
    return result.output
  }
}

export type ScientificCapabilityCanaryCleanup =
  | { status: "not_applicable"; job: JobBroker.Job }
  | { status: "closed"; job: JobBroker.Job }
  | { status: "failed"; job_id: string; error: string }

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function cleanupScientificCapabilityCanaryJob(input: {
  tool: CapabilityTool
  ctx: Tool.Context
  id: string
  jobID: string
  state?: JobBroker.Job
}): Promise<ScientificCapabilityCanaryCleanup> {
  let state = input.state
  try {
    if (!state) {
      const current = await input.tool.execute({ action: "status", id: input.id, job_id: input.jobID }, input.ctx)
      state = job(current)
    }
    if (!terminal.has(state.status)) {
      const cancelled = await input.tool.execute({ action: "cancel", id: input.id, job_id: input.jobID }, input.ctx)
      state = job(cancelled)
    }
    if (state.target.kind !== "modal") return { status: "not_applicable", job: state }
    const result = await input.tool.execute({ action: "release", id: input.id, job_id: input.jobID }, input.ctx)
    const released = job(result)
    if (released.lifecycle?.resource !== "closed" || released.modal?.retained_volume === true) {
      throw new Error(
        `release returned resource=${released.lifecycle?.resource ?? "unknown"} retained_volume=${released.modal?.retained_volume ?? "unknown"}`,
      )
    }
    return { status: "closed", job: released }
  } catch (error) {
    return { status: "failed", job_id: input.jobID, error: errorText(error) }
  }
}

export async function runScientificCapabilityCanary(input: {
  tool: CapabilityTool
  ctx: Tool.Context
  id: string
  target: "local" | "modal"
  timeoutSeconds: number
}) {
  if (input.target === "local") {
    await input.tool.execute({ action: "setup", id: input.id }, input.ctx)
  }
  const doctor = await input.tool.execute({ action: "doctor", id: input.id }, input.ctx)

  const started = await input.tool.execute({ action: "smoke", id: input.id, target: input.target }, input.ctx)
  let state = job(started)
  const jobID = state.id
  const deadline = Date.now() + input.timeoutSeconds * 1_000
  let cleanup: ScientificCapabilityCanaryCleanup | undefined

  try {
    const current = await input.tool.execute({ action: "status", id: input.id, job_id: jobID }, input.ctx)
    state = job(current)
    while (!terminal.has(state.status)) {
      const remaining = Math.ceil((deadline - Date.now()) / 1_000)
      if (remaining <= 0) throw new Error(`Scientific capability canary ${input.id}/${input.target} timed out`)
      const waited = await input.tool.execute(
        {
          action: "wait",
          id: input.id,
          job_id: jobID,
          seconds: Math.max(1, Math.min(60, remaining)),
        },
        input.ctx,
      )
      state = job(waited)
    }

    if (state.status !== "succeeded") {
      const logs = await input.tool.execute({ action: "logs", id: input.id, job_id: jobID, bytes: 64_000 }, input.ctx)
      throw new Error(`Scientific capability canary ${input.id}/${input.target} ended ${state.status}.\n${logs.output}`)
    }

    const logs = await input.tool.execute({ action: "logs", id: input.id, job_id: jobID, bytes: 64_000 }, input.ctx)
    const artifacts = await input.tool.execute({ action: "artifacts", id: input.id, job_id: jobID }, input.ctx)
    const verified = await input.tool.execute({ action: "verify", id: input.id, job_id: jobID }, input.ctx)
    const result = {
      capability: input.id,
      target: input.target,
      job_id: jobID,
      status: state.status,
      doctor: parsedOutput(doctor),
      logs: logs.output,
      artifacts: parsedOutput(artifacts),
      verification: parsedOutput(verified),
    }
    cleanup = await cleanupScientificCapabilityCanaryJob({
      tool: input.tool,
      ctx: input.ctx,
      id: input.id,
      jobID,
      state,
    })
    if (cleanup.status === "failed") {
      throw new Error(
        `Scientific capability canary ${input.id}/${input.target} produced valid evidence but could not close paid resources for job ${jobID}: ${cleanup.error}. Retry scientific_capability release for this exact job.`,
      )
    }
    return { ...result, cleanup }
  } catch (error) {
    cleanup ??= await cleanupScientificCapabilityCanaryJob({
      tool: input.tool,
      ctx: input.ctx,
      id: input.id,
      jobID,
      state,
    })
    if (cleanup.status === "failed" && !errorText(error).includes(cleanup.error)) {
      throw new Error(
        `${errorText(error)} Cleanup also failed for job ${jobID}: ${cleanup.error}. Retry scientific_capability release for this exact job.`,
        { cause: error },
      )
    }
    throw error
  }
}

export async function createScientificCapabilityCanaryTool(
  agent?: Parameters<typeof ScientificCapabilityTool.init>[0],
) {
  return ScientificCapabilityTool.init(agent)
}

/**
 * Create the release-canary tool context without discovering or selecting an
 * inference provider. Scientific capability canaries execute an explicit,
 * bounded lifecycle and never ask a model to choose a tool, so coupling them
 * to Provider.defaultModel() makes a clean release artifact incorrectly depend
 * on a user's provider credentials.
 */
export async function createScientificCapabilityCanaryContext(agent: Agent.Info): Promise<Tool.Context> {
  const session = await Session.create({ title: "Scientific capability release canary" })
  const messageID = Identifier.ascending("message")
  const message: MessageV2.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: messageID,
    modelID: "scientific-capability-canary",
    providerID: "openscience-internal",
    mode: "debug",
    agent: agent.name,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
  await Session.updateMessage(message)

  const ruleset = PermissionNext.merge(agent.permission, session.permission ?? [])
  return {
    sessionID: session.id,
    messageID,
    callID: Identifier.ascending("part"),
    agent: agent.name,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    async ask(req) {
      for (const pattern of req.patterns) {
        if (PermissionNext.evaluate(req.permission, pattern, ruleset).action === "deny") {
          throw new PermissionNext.DeniedError(ruleset)
        }
      }
    },
  }
}
