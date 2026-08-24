import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { Lock } from "@/util/lock"
import { observableToolStatus } from "@/session/tool-outcome"
import { Truncate } from "./truncation"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "@/project/instance"
import fs from "fs/promises"
import { constants as FS } from "fs"
import path from "path"
import { TaskAttempt, TaskCapacity } from "./task-attempt"
import { Storage } from "@/storage/storage"

export const DELEGATION_PROFILES = ["explore", "execute"] as const
export const DELEGATION_SPECIALISTS = ["biology", "physics", "ml"] as const
export function isComputeDelegationProfile(name: string) {
  return name === "execute"
}
export const NORMAL_CHILD_AGENTS = MessageV2.ResearchEffortLimits.normal
export const MAX_CHILD_AGENTS = MessageV2.ResearchEffortLimits.ultra
export const TASK_WALL_CLOCK_MS = {
  normal: 10 * 60_000,
  ultra: 20 * 60_000,
} as const satisfies Record<MessageV2.ResearchEffort, number>
export const TASK_HANDOFF_CHARS = 12_000
export const TASK_MEMORY_CHARS = 8_000
const configuredComputeCap = Number(process.env.OPENSCIENCE_MAX_COMPUTE_SUBAGENTS)
const MAX_COMPUTE_SUBAGENTS =
  Number.isFinite(configuredComputeCap) && configuredComputeCap >= 1 ? Math.floor(configuredComputeCap) : 2

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.enum(DELEGATION_PROFILES).describe("The internal explore or execute profile"),
  specialist: z
    .enum(DELEGATION_SPECIALISTS)
    .optional()
    .describe("Optional user-selected biology, physics, or ML specialist for an execute phase"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export function childPermissionRules(primaryTools: string[] = []): PermissionNext.Ruleset {
  return [
    ...primaryTools.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    { permission: "todowrite", pattern: "*", action: "deny" },
    { permission: "todoread", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
  ]
}

export function assertTaskContinuation(input: { session: Session.Info; parentSessionID: string; projectID: string }) {
  if (input.session.projectID !== input.projectID || input.session.parentID !== input.parentSessionID) {
    throw new Error(
      `Task continuation session ${input.session.id} is not a direct child of the calling session ${input.parentSessionID}`,
    )
  }
  return input.session
}

const TOOL_OUTPUT_NAME = /^tool_[A-Za-z0-9]{26}$/

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Tool truncation output lives outside isolated session workspaces. A Task
 * prompt previously passed that host path to the child as plain text, but it
 * did not transfer filesystem authority. Copy only exact broker-owned
 * `tool_*` files named in the prompt into the child's scratch workspace and
 * rewrite those references. This keeps arbitrary external paths and sibling
 * workspaces outside the child boundary.
 */
export async function materializeTaskToolOutputs(input: {
  prompt: string
  parentSessionID: string
  childSessionID: string
}) {
  const root = await fs.realpath(Truncate.DIR).catch(() => undefined)
  if (!root) return { prompt: input.prompt, files: [] as string[] }

  const aliases = [...new Set([path.resolve(Truncate.DIR), root])]
  const references = [
    ...new Set(
      aliases.flatMap((alias) =>
        Array.from(
          input.prompt.matchAll(new RegExp(`${escapeRegex(alias)}/tool_[A-Za-z0-9]{26}(?![A-Za-z0-9])`, "g")),
          (match) => match[0],
        ),
      ),
    ),
  ]
  if (references.length === 0) return { prompt: input.prompt, files: [] as string[] }

  const sources = await Promise.all(
    references.map(async (reference) => {
      const name = path.basename(reference)
      const info = await fs.lstat(reference).catch(() => undefined)
      const source = await fs.realpath(reference).catch(() => undefined)
      if (
        !TOOL_OUTPUT_NAME.test(name) ||
        !info?.isFile() ||
        !source ||
        path.dirname(source) !== root ||
        path.basename(source) !== name ||
        !(await SessionFilesystem.ownsToolOutput({ sessionID: input.parentSessionID, path: source }))
      ) {
        throw new Error(`Task input references an unavailable broker tool output: ${name}`)
      }
      return { reference, source, name }
    }),
  )

  const workspace = await SessionFilesystem.workspace(input.childSessionID)
  const directory = await fs.mkdtemp(path.join(workspace, ".task-handoff-"))
  const destinations = new Map<string, string>()
  for (const source of sources) {
    if (destinations.has(source.source)) continue
    const destination = path.join(directory, source.name)
    await fs.copyFile(source.source, destination, FS.COPYFILE_EXCL)
    destinations.set(source.source, destination)
  }
  const prompt = sources.reduce(
    (result, source) => result.replaceAll(source.reference, destinations.get(source.source)!),
    input.prompt,
  )
  return { prompt, files: [...destinations.values()] }
}

export function summarizeTurn(messages: MessageV2.WithParts[], previous: Set<string>) {
  const current = messages.filter((message) => !previous.has(message.info.id))
  const summary = current
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"))
    .map((part) => ({
      id: part.id,
      tool: part.tool,
      state: {
        status: observableToolStatus(part),
        title: part.state.status === "completed" ? part.state.title : undefined,
      },
    }))
  const usage = current.reduce(
    (total, message) => {
      if (message.info.role !== "assistant") return total
      total.cost += message.info.cost
      total.tokens.input += message.info.tokens.input
      total.tokens.output += message.info.tokens.output
      total.tokens.cache.read += message.info.tokens.cache.read
      total.tokens.cache.write += message.info.tokens.cache.write
      return total
    },
    {
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
    },
  )
  return { summary, usage }
}

export function taskText(messages: MessageV2.WithParts[], previous: Set<string>) {
  return messages
    .filter((message) => !previous.has(message.info.id) && message.info.role === "assistant")
    .toSorted((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
    .flatMap((message) =>
      message.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.trim().length > 0)
        .toSorted((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0) || a.id.localeCompare(b.id)),
    )
    .map((part) => part.text.trim())
    .join("\n\n")
}

export type TaskOutcome = {
  outcome: "completed" | "partial" | "timed_out" | "error"
  stopReason: "completed" | "max_steps" | "tool_failures" | "wall_clock" | "provider_error"
}

/**
 * The child transcript remains available through its session id. The parent
 * should receive a compact handoff instead of importing another agent's whole
 * context. Preserve both the opening findings and the closing conclusion when
 * a child ignores the requested response bound.
 */
export function taskHandoff(text: string, limit = TASK_HANDOFF_CHARS) {
  const body = text.replace(/\s*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/u, "").trim()
  if (body.length <= limit) return { text: body, truncated: false }
  const marker = "\n\n[… middle omitted from the parent handoff; the full result remains in the child session …]\n\n"
  if (limit <= marker.length) return { text: body.slice(0, Math.max(0, limit)), truncated: true }
  const budget = Math.max(0, limit - marker.length)
  const head = Math.ceil(budget * 0.72)
  const tail = budget - head
  return {
    text: body.slice(0, head).trimEnd() + marker + (tail ? body.slice(-tail).trimStart() : ""),
    truncated: true,
  }
}

export function classifyTaskOutcome(input: {
  timedOut: boolean
  finish?: string
  error?: unknown
  toolCalls?: number
  failedToolCalls?: number
}): TaskOutcome {
  if (input.timedOut) return { outcome: "timed_out", stopReason: "wall_clock" }
  if (input.error) return { outcome: "error", stopReason: "provider_error" }
  if (input.finish === "max-steps") return { outcome: "partial", stopReason: "max_steps" }
  if (input.toolCalls && input.failedToolCalls === input.toolCalls) {
    return { outcome: "partial", stopReason: "tool_failures" }
  }
  return { outcome: "completed", stopReason: "completed" }
}

export function taskDispatchBudget(
  messages: MessageV2.WithParts[],
  parentID: string,
  callID: string | undefined,
  effort: MessageV2.ResearchEffort,
) {
  const limit = MessageV2.childAgentLimit(effort)
  const roots = new Map<string, string>()
  const ordered = messages.toSorted(
    (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
  )
  const cursor = { root: undefined as string | undefined }
  for (const message of ordered) {
    if (message.info.role !== "user") continue
    const substantive = message.parts.some(
      (part) => part.type !== "compaction" && !(part.type === "text" && part.synthetic),
    )
    if (substantive || !cursor.root) cursor.root = message.info.id
    roots.set(message.info.id, cursor.root)
  }
  const root = roots.get(parentID) ?? parentID
  const calls = ordered
    .filter((message): message is MessageV2.WithParts & { info: MessageV2.Assistant } => {
      return message.info.role === "assistant" && (roots.get(message.info.parentID) ?? message.info.parentID) === root
    })
    .flatMap((message) =>
      message.parts
        .filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task")
        .map((part) => ({ created: message.info.time.created, part })),
    )
    .sort((a, b) => a.created - b.created || a.part.id.localeCompare(b.part.id))
  const found = calls.findIndex((call) => call.part.callID === callID)
  const dispatch = found === -1 ? calls.length + 1 : found + 1
  if (dispatch <= limit) return { dispatch, limit }
  const label = effort === "normal" ? "Normal" : "Ultra"
  throw new Error(
    `Research ${label} permits ${limit} Task calls total per user turn; continuations count. Task call ${dispatch} must be completed by the lead agent or deferred to a new user turn.`,
  )
}

export async function withTaskDeadline<T>(run: () => Promise<T>, cancel: () => void, timeoutMs: number) {
  const execution = run().then(
    (result) => ({ result, error: undefined, timedOut: false as const }),
    (error: unknown) => ({ result: undefined, error, timedOut: false as const }),
  )
  const timeout = Promise.withResolvers<{
    result: undefined
    error: undefined
    timedOut: true
  }>()
  const timer = setTimeout(() => {
    cancel()
    timeout.resolve({ result: undefined, error: undefined, timedOut: true })
  }, timeoutMs)

  // Cancellation should abort the provider stream, but the budget must remain
  // hard even if a transport ignores its AbortSignal. `execution` handles its
  // own eventual rejection, so returning at the deadline cannot create an
  // unhandled promise while the session cancellation tears remaining work down.
  try {
    return await Promise.race([execution, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Promise.all(DELEGATION_PROFILES.map((name) => Agent.get(name))).then((items) =>
    items.filter((agent): agent is Agent.Info => agent !== undefined),
  )

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()
      const effort = MessageV2.resolveResearchEffort(ctx.extra?.effort)
      const maxConcurrentChildren = MessageV2.childAgentLimit(effort)
      const budgetMs = TASK_WALL_CLOCK_MS[effort]

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.specialist ?? params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
            specialist: params.specialist,
          },
        })
      }

      const profile = await Agent.get(params.subagent_type)
      if (!profile) throw new Error(`Internal delegation profile ${params.subagent_type} is unavailable`)
      const agent = params.specialist ? await Agent.get(params.specialist) : profile
      if (!agent) throw new Error(`Delegation specialist ${params.specialist} is unavailable`)

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
      const assistant = msg.info
      if (!ctx.callID) throw new Error("Task execution requires a durable tool call id")
      const dispatch = await (async () => {
        using _ = await Lock.write(`task-dispatch:${ctx.sessionID}:${assistant.parentID}`)
        const messages = await Session.messages({ sessionID: ctx.sessionID })
        return taskDispatchBudget(messages, assistant.parentID, ctx.callID, effort)
      })()
      const identity = {
        projectID: Instance.project.id,
        parentSessionID: ctx.sessionID,
        parentMessageID: assistant.id,
        parentUserMessageID: assistant.parentID,
        callID: ctx.callID,
      }
      const reserved = await TaskAttempt.reserve({
        ...identity,
        fingerprint: TaskAttempt.fingerprint(params),
        legacyFingerprint: TaskAttempt.legacyFingerprint(params),
        childSessionID: params.session_id,
      })
      const started = reserved.createdAt

      await using attemptLease = await TaskAttempt.acquire(identity, budgetMs, ctx.abort)
      return attemptLease.during(async () => {
        const current = await TaskAttempt.read(identity)
        if (!current) throw new Error(`Durable Task attempt ${ctx.callID} disappeared after reservation`)
        if (current.status === "completed" && current.result) return current.result

        const existing = await Session.get(reserved.childSessionID).catch((error) => {
          if (Storage.NotFoundError.isInstance(error)) return
          throw error
        })
        const session = existing
          ? assertTaskContinuation({
              session: existing,
              parentSessionID: ctx.sessionID,
              projectID: Instance.project.id,
            })
          : await Session.createNext({
              id: reserved.childSessionID,
              parentID: ctx.sessionID,
              directory: Instance.directory,
              title:
                params.description +
                (params.specialist
                  ? ` (@${params.specialist} specialist, ${params.subagent_type} phase)`
                  : ` (@${params.subagent_type} subagent)`),
              permission: childPermissionRules(config.experimental?.primary_tools),
            })
        await SessionFilesystem.grantTaskHandoff({
          parentSessionID: ctx.sessionID,
          childSessionID: session.id,
        })

        const model = agent.model ?? { modelID: assistant.modelID, providerID: assistant.providerID }
        const initial = await Session.messages({ sessionID: session.id })
        const bound = await TaskAttempt.bind({
          ...identity,
          previousMessageIDs: initial.map((message) => message.info.id),
        })
        const previous = new Set(bound.previousMessageIDs)
        const timing = {
          queuedMs: Math.max(0, Date.now() - started),
          activeStartedAt: Date.now(),
          activeMs: 0,
        }

        // This is the durable parent→child binding. It must land before the
        // child provider can run so a killed process leaves a discoverable,
        // reusable child rather than an orphaned session.
        await ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            startedAt: started,
            effort,
            maxConcurrentChildren,
            maxGlobalChildren: MAX_CHILD_AGENTS,
            taskDispatch: dispatch.dispatch,
            maxTaskDispatches: dispatch.limit,
            budgetMs,
            queuedMs: timing.queuedMs,
            activeStartedAt: timing.activeStartedAt,
          },
        })

        const messages = await Session.messages({ sessionID: session.id })
        const turn = messages.filter((message) => !previous.has(message.info.id))
        const terminal = turn
          .filter(
            (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
              message.info.role === "assistant",
          )
          .findLast((message) => {
            if (message.info.error) return true
            if (!message.info.finish) return false
            const hasTool = message.parts.some((part) => part.type === "tool")
            return !MessageV2.isContinuingTurn(message.info.finish, hasTool)
          })
        const settled = await TaskAttempt.settle(identity, terminal?.info.time.completed)
        timing.activeMs = settled.activeMs ?? 0

        const deadline = terminal
          ? { result: terminal, error: undefined, timedOut: false as const }
          : await (async () => {
              if (!TaskAttempt.remaining(settled, budgetMs)) {
                return { result: undefined, error: undefined, timedOut: true as const }
              }
              // Capacity queues and server downtime are not child execution.
              // Start the durable active clock only after both global slots
              // are held, immediately before resuming provider work.
              await using childSlot = await TaskCapacity.acquire("child", MAX_CHILD_AGENTS, ctx.abort)
              await using computeSlot = isComputeDelegationProfile(params.subagent_type)
                ? await TaskCapacity.acquire("compute", MAX_COMPUTE_SUBAGENTS, ctx.abort)
                : undefined
              timing.activeStartedAt = Date.now()
              timing.queuedMs = Math.max(0, timing.activeStartedAt - started)
              const token = crypto.randomUUID()
              const active = await TaskAttempt.activate({ ...identity, token })
              timing.activeMs = active.activeMs ?? 0
              const remaining = TaskAttempt.remaining(active, budgetMs)
              if (!remaining) {
                const ended = await TaskAttempt.deactivate({ ...identity, token })
                timing.activeMs = ended.activeMs ?? timing.activeMs
                return { result: undefined, error: undefined, timedOut: true as const }
              }
              const execute = async () => {
                await ctx.metadata({
                  title: params.description,
                  metadata: {
                    sessionId: session.id,
                    model,
                    startedAt: started,
                    effort,
                    maxConcurrentChildren,
                    maxGlobalChildren: MAX_CHILD_AGENTS,
                    taskDispatch: dispatch.dispatch,
                    maxTaskDispatches: dispatch.limit,
                    budgetMs,
                    queuedMs: timing.queuedMs,
                    activeStartedAt: timing.activeStartedAt,
                    activeMs: timing.activeMs,
                  },
                })

                const observed: Record<
                  string,
                  { id: string; tool: string; state: { status: string; title?: string } }
                > = {}
                const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
                  if (evt.properties.part.sessionID !== session.id) return
                  if (evt.properties.part.messageID === reserved.childMessageID) return
                  if (evt.properties.part.type !== "tool") return
                  const part = evt.properties.part
                  observed[part.id] = {
                    id: part.id,
                    tool: part.tool,
                    state: {
                      status: part.state.status,
                      title: part.state.status === "completed" ? part.state.title : undefined,
                    },
                  }
                  await ctx.metadata({
                    title: params.description,
                    metadata: {
                      summary: Object.values(observed).sort((a, b) => a.id.localeCompare(b.id)),
                      sessionId: session.id,
                      model,
                      startedAt: started,
                      elapsedMs: Date.now() - started,
                      activeMs: Math.min(budgetMs, timing.activeMs + Math.max(0, Date.now() - timing.activeStartedAt)),
                      effort,
                      maxConcurrentChildren,
                      maxGlobalChildren: MAX_CHILD_AGENTS,
                      taskDispatch: dispatch.dispatch,
                      maxTaskDispatches: dispatch.limit,
                      budgetMs,
                      queuedMs: timing.queuedMs,
                      activeStartedAt: timing.activeStartedAt,
                    },
                  })
                })
                using subscription = defer(unsub)

                function cancel() {
                  SessionPrompt.cancel(session.id)
                }
                ctx.abort.addEventListener("abort", cancel)
                using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
                const exists = messages.some(
                  (message) => message.info.role === "user" && message.info.id === reserved.childMessageID,
                )
                const childGuidance = [
                  `You own one ${params.subagent_type} phase${params.specialist ? ` with the ${params.specialist} specialist` : ""} for the lead Research agent. The assignment in the user message is authoritative.`,
                  "Work independently on that phase. Delegation is unavailable; load a domain skill only when it materially improves the result.",
                  "Do not return a diary of searches, reads, or commands. Your final response is a decision-ready handoff to the lead, not a second user-facing report.",
                  "Keep the final response under 1,200 words. Use only the Markdown sections that carry substance: Outcome; Findings; Evidence; Changes / outputs; Limitations; Next action.",
                  "Preserve exact paths, identifiers, numeric results, commands, and error strings when they matter. Distinguish observed evidence from inference. If blocked or partial, say exactly what remains.",
                  "Do not wrap the response in XML or JSON and do not restate these instructions.",
                ].join("\n")
                const run = async () => {
                  if (exists) return SessionPrompt.loop(session.id)
                  const transfer = await materializeTaskToolOutputs({
                    prompt: params.prompt,
                    parentSessionID: ctx.sessionID,
                    childSessionID: session.id,
                  })
                  return SessionPrompt.prompt({
                    messageID: reserved.childMessageID,
                    sessionID: session.id,
                    model,
                    agent: agent.name,
                    effort,
                    delegation: false,
                    system: childGuidance,
                    tools: {
                      todowrite: false,
                      todoread: false,
                      task: false,
                      ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
                    },
                    parts: await SessionPrompt.resolvePromptParts(transfer.prompt),
                  })
                }
                return withTaskDeadline(run, () => SessionPrompt.cancel(session.id), remaining)
              }
              const interval = Math.min(5_000, Math.max(250, Math.floor(budgetMs / 20)))
              const pulse = setInterval(() => {
                void TaskAttempt.pulse({ ...identity, token }).catch(() => undefined)
              }, interval)
              try {
                return await execute()
              } finally {
                clearInterval(pulse)
                const ended = await TaskAttempt.deactivate({ ...identity, token })
                timing.activeMs = ended.activeMs ?? timing.activeMs
              }
            })()

        if (deadline.error && !deadline.timedOut) throw deadline.error
        await Session.flushPendingParts(session.id)
        const complete = await Session.messages({ sessionID: session.id })
        const { summary, usage } = summarizeTurn(complete, previous)
        const text = taskText(complete, previous)
        const child = deadline.result?.info.role === "assistant" ? deadline.result.info : terminal?.info
        const failedToolCalls = summary.filter((part) => part.state.status === "error").length
        const taskOutcome = classifyTaskOutcome({
          timedOut: deadline.timedOut,
          finish: child?.finish,
          error: deadline.error ?? child?.error,
          toolCalls: summary.length,
          failedToolCalls,
        })
        const raw =
          text ||
          (deadline.timedOut
            ? `No textual findings were emitted before the cutoff. The child completed ${summary.length} tool calls in this turn.`
            : taskOutcome.outcome === "error"
              ? `The child failed before emitting textual findings after ${summary.length} tool calls in this turn.`
              : taskOutcome.outcome === "completed"
                ? "The child completed without emitting textual findings."
                : `The child stopped before emitting textual findings after ${summary.length} tool calls in this turn.`)
        const handoff = taskHandoff(raw)
        const memory = taskHandoff(handoff.text, TASK_MEMORY_CHARS)
        const activeMs = timing.activeMs
        const output = [
          ...(taskOutcome.stopReason === "wall_clock"
            ? [
                `[Child stopped at the ${Math.round(budgetMs / 60_000)}-minute wall-clock budget; partial result follows.]`,
              ]
            : taskOutcome.stopReason === "max_steps"
              ? ["[Child reached its bounded step limit; partial result follows.]"]
              : taskOutcome.stopReason === "tool_failures"
                ? ["[Every child tool call failed; treat the following as a partial, blocked result.]"]
                : taskOutcome.stopReason === "provider_error"
                  ? ["[Child failed before completion; any partial result follows.]"]
                  : []),
          handoff.text,
        ]
          .filter(Boolean)
          .join("\n")
        const result = TaskAttempt.Result.parse({
          title: params.description,
          metadata: {
            summary,
            sessionId: session.id,
            model,
            startedAt: started,
            durationMs: Date.now() - started,
            toolCalls: summary.length,
            failedToolCalls,
            usage,
            effort,
            profile: params.subagent_type,
            ...(params.specialist && { specialist: params.specialist }),
            maxConcurrentChildren,
            maxGlobalChildren: MAX_CHILD_AGENTS,
            taskDispatch: dispatch.dispatch,
            maxTaskDispatches: dispatch.limit,
            budgetMs,
            timedOut: deadline.timedOut,
            queuedMs: timing.queuedMs,
            activeMs,
            outcome: taskOutcome.outcome,
            stopReason: taskOutcome.stopReason,
            handoff: memory.text,
            handoffTruncated: handoff.truncated || memory.truncated,
            resultChars: raw.length,
          },
          output,
        })
        await TaskAttempt.complete({ ...identity, result })
        return result
      })
    },
  }
})
