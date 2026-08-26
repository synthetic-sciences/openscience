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
import { observableToolStatus } from "@/session/tool-outcome"
import { Truncate } from "./truncation"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "@/project/instance"
import fs from "fs/promises"
import { constants as FS } from "fs"
import path from "path"
import { TaskAttempt, TaskCapacity } from "./task-attempt"
import { Storage } from "@/storage/storage"
import { ToolSelection } from "@/session/tool-selection"
import { availableParallelism } from "node:os"

export const DELEGATION_PROFILES = ["explore", "execute"] as const
export const DELEGATION_SPECIALISTS = ["biology", "physics", "ml"] as const
export function isComputeDelegationProfile(name: string) {
  return name === "execute"
}

export function taskContinuationID(value: string | undefined, parentSessionID: string) {
  if (!value || value === parentSessionID) return undefined
  if (/^ses_(?:new|none|placeholder|current|parent)$/i.test(value)) return undefined
  return value
}
const configuredChildCap = Number(process.env.OPENSCIENCE_MAX_CHILD_AGENTS)
export const MAX_CHILD_AGENTS =
  Number.isFinite(configuredChildCap) && configuredChildCap >= 1
    ? Math.floor(configuredChildCap)
    : Math.max(2, availableParallelism())
const configuredComputeCap = Number(process.env.OPENSCIENCE_MAX_COMPUTE_SUBAGENTS)
const MAX_COMPUTE_SUBAGENTS =
  Number.isFinite(configuredComputeCap) && configuredComputeCap >= 1
    ? Math.floor(configuredComputeCap)
    : MAX_CHILD_AGENTS

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.enum(DELEGATION_PROFILES).describe("The internal explore or execute profile"),
  specialist: z
    .enum(DELEGATION_SPECIALISTS)
    .optional()
    .describe("Optional user-selected biology, physics, or ML specialist for an execute phase"),
  session_id: z
    .string()
    .startsWith("ses_")
    .describe(
      "Exact sessionId returned by an earlier successful Task call from this parent session. Never use the current or parent session ID.",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export function childPermissionRules(primaryTools: string[] = []): PermissionNext.Ruleset {
  return [
    ...primaryTools.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    { permission: "todowrite", pattern: "*", action: "deny" },
    { permission: "todoread", pattern: "*", action: "deny" },
  ]
}

export function assertTaskContinuation(input: { session: Session.Info; parentSessionID: string; projectID: string }) {
  if (input.session.projectID !== input.projectID || input.session.parentID !== input.parentSessionID) {
    throw new Error(
      `Task continuation session ${input.session.id} is not a direct child of the calling session ${input.parentSessionID}. Use only the exact sessionId returned by an earlier successful Task call from this session.`,
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
  outcome: "completed" | "partial" | "error"
  stopReason: "completed" | "max_steps" | "tool_failures" | "provider_error"
}

/**
 * The child transcript remains available through its session id. The parent
 * should receive the child's final handoff instead of importing its tool
 * transcript. An explicit caller-supplied limit remains available for legacy
 * defensive uses, but normal delegation does not truncate the result.
 */
export function taskHandoff(text: string, limit?: number) {
  const body = text.replace(/\s*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/u, "").trim()
  if (limit === undefined || body.length <= limit) return { text: body, truncated: false }
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
  finish?: string
  error?: unknown
  hasText?: boolean
  toolCalls?: number
  failedToolCalls?: number
}): TaskOutcome {
  if (input.error) return { outcome: input.hasText ? "partial" : "error", stopReason: "provider_error" }
  if (input.finish === "max-steps") return { outcome: "partial", stopReason: "max_steps" }
  if (input.toolCalls && input.failedToolCalls === input.toolCalls) {
    return { outcome: "partial", stopReason: "tool_failures" }
  }
  return { outcome: "completed", stopReason: "completed" }
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
      const configured = MessageV2.resolveDelegationSettings(ctx.extra?.delegationSettings, { effort })
      const settings =
        configured.level === "off" && ctx.extra?.bypassAgentCheck
          ? { ...configured, level: "light" as const }
          : configured
      // Some models eagerly fill every optional schema field with the current
      // session or a `ses_new` placeholder. Those values unambiguously mean a
      // new child; only a different, real direct-child id is a continuation.
      const continuationID = taskContinuationID(params.session_id, ctx.sessionID)
      const continuation = continuationID
        ? assertTaskContinuation({
            session: await Session.get(continuationID),
            parentSessionID: ctx.sessionID,
            projectID: Instance.project.id,
          })
        : undefined

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

      const thinCaller = ToolSelection.minimalResearchAgent(ctx.agent)
      const profile = await Agent.get(params.subagent_type)
      if (!profile) throw new Error(`Internal delegation profile ${params.subagent_type} is unavailable`)
      // Minimal Research parents delegate through the same minimal runtime.
      // Specialist intent remains explicit in childGuidance and skill routing
      // without restoring the legacy system prompt and eager tool catalog.
      const agent = thinCaller
        ? await Agent.get("research")
        : params.specialist
          ? await Agent.get(params.specialist)
          : profile
      if (!agent) throw new Error(`Delegation specialist ${params.specialist} is unavailable`)

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
      const assistant = msg.info
      if (!ctx.callID) throw new Error("Task execution requires a durable tool call id")
      const identity = {
        projectID: Instance.project.id,
        parentSessionID: ctx.sessionID,
        parentMessageID: assistant.id,
        parentUserMessageID: assistant.parentID,
        callID: ctx.callID,
      }
      const reserved = await TaskAttempt.reserve({
        ...identity,
        fingerprint: TaskAttempt.fingerprint({ ...params, session_id: continuationID }),
        legacyFingerprint: TaskAttempt.legacyFingerprint({ ...params, session_id: continuationID }),
        childSessionID: continuationID,
      })
      const started = reserved.createdAt

      await using attemptLease = await TaskAttempt.acquire(identity, Number.POSITIVE_INFINITY, ctx.abort)
      return attemptLease.during(async () => {
        const current = await TaskAttempt.read(identity)
        if (!current) throw new Error(`Durable Task attempt ${ctx.callID} disappeared after reservation`)
        if (current.status === "completed" && current.result) return current.result

        const existing =
          continuation ??
          (await Session.get(reserved.childSessionID).catch((error) => {
            if (Storage.NotFoundError.isInstance(error)) return
            throw error
          }))
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

        const model = settings.workerModel ??
          agent.model ?? { modelID: assistant.modelID, providerID: assistant.providerID }
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
            delegation: settings,
            maxConcurrentChildren: MAX_CHILD_AGENTS,
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

        const execution = terminal
          ? { result: terminal, error: undefined }
          : await (async () => {
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
              const execute = async () => {
                await ctx.metadata({
                  title: params.description,
                  metadata: {
                    sessionId: session.id,
                    model,
                    startedAt: started,
                    effort,
                    delegation: settings,
                    maxConcurrentChildren: MAX_CHILD_AGENTS,
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
                      activeMs: timing.activeMs + Math.max(0, Date.now() - timing.activeStartedAt),
                      effort,
                      delegation: settings,
                      maxConcurrentChildren: MAX_CHILD_AGENTS,
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
                  "Work independently on that phase. Delegate genuinely independent work when it materially improves the result; runtime capacity may queue it. Load a domain skill only when useful.",
                  "Do not return a diary of searches, reads, or commands. Your final response is a decision-ready handoff to the lead, not a second user-facing report.",
                  "Use only the Markdown sections that carry substance: Outcome; Findings; Evidence; Changes / outputs; Limitations; Next action.",
                  "Preserve exact paths, identifiers, numeric results, commands, and error strings when they matter. Distinguish observed evidence from inference. If blocked or partial, say exactly what remains.",
                  "Do not wrap the response in XML or JSON and do not restate these instructions.",
                  settings.autonomy === "interactive"
                    ? "If the assignment contains a genuinely consequential ambiguity, return one precise question to the lead instead of guessing."
                    : settings.autonomy === "autonomous"
                      ? "Resolve ordinary ambiguities independently within the current permission boundary; surface only decisions that materially affect the result."
                      : "Resolve routine ambiguities independently and flag consequential assumptions in the handoff.",
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
                    delegation: true,
                    delegationSettings: settings,
                    system: childGuidance,
                    tools: {
                      todowrite: false,
                      todoread: false,
                      task: true,
                      ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
                    },
                    parts: await SessionPrompt.resolvePromptParts(transfer.prompt),
                  })
                }
                return run().then(
                  (result) => ({ result, error: undefined }),
                  (error: unknown) => ({ result: undefined, error }),
                )
              }
              const pulse = setInterval(() => {
                void TaskAttempt.pulse({ ...identity, token }).catch(() => undefined)
              }, 5_000)
              try {
                return await execute()
              } finally {
                clearInterval(pulse)
                const ended = await TaskAttempt.deactivate({ ...identity, token })
                timing.activeMs = ended.activeMs ?? timing.activeMs
              }
            })()

        await Session.flushPendingParts(session.id)
        const complete = await Session.messages({ sessionID: session.id })
        const { summary, usage } = summarizeTurn(complete, previous)
        const text = taskText(complete, previous)
        const child = execution.result?.info.role === "assistant" ? execution.result.info : terminal?.info
        const failedToolCalls = summary.filter((part) => part.state.status === "error").length
        const taskOutcome = classifyTaskOutcome({
          finish: child?.finish,
          error: execution.error ?? child?.error,
          hasText: text.trim().length > 0,
          toolCalls: summary.length,
          failedToolCalls,
        })
        const raw =
          text ||
          (taskOutcome.outcome === "error"
            ? `The child failed before emitting textual findings after ${summary.length} tool calls in this turn.`
            : taskOutcome.outcome === "completed"
              ? "The child completed without emitting textual findings."
              : `The child stopped before emitting textual findings after ${summary.length} tool calls in this turn.`)
        const handoff = taskHandoff(raw)
        const activeMs = timing.activeMs
        const output = [
          ...(taskOutcome.stopReason === "max_steps"
            ? ["[Child reached its bounded step limit; partial result follows.]"]
            : taskOutcome.stopReason === "tool_failures"
              ? ["[Every child tool call failed; treat the following as a partial, blocked result.]"]
              : taskOutcome.stopReason === "provider_error"
                ? ["[Child stopped on a provider error; its usable partial result follows.]"]
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
            delegation: settings,
            profile: params.subagent_type,
            ...(params.specialist && { specialist: params.specialist }),
            maxConcurrentChildren: MAX_CHILD_AGENTS,
            queuedMs: timing.queuedMs,
            activeMs,
            outcome: taskOutcome.outcome,
            stopReason: taskOutcome.stopReason,
            handoff: handoff.text,
            handoffTruncated: handoff.truncated,
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
