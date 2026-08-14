import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { HierarchicalSemaphore } from "../util/semaphore"
import { Lock } from "@/util/lock"
import { observableToolStatus } from "@/session/tool-outcome"
import { Truncate } from "./truncation"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "@/project/instance"
import fs from "fs/promises"
import { constants as FS } from "fs"
import path from "path"

export const DELEGATION_PROFILES = ["explore", "execute", "review"] as const
export function isComputeDelegationProfile(name: string) {
  return name === "execute"
}
export const NORMAL_CHILD_AGENTS = MessageV2.ResearchEffortLimits.normal
export const MAX_CHILD_AGENTS = MessageV2.ResearchEffortLimits.ultra
export const TASK_WALL_CLOCK_MS = {
  normal: 10 * 60_000,
  ultra: 20 * 60_000,
} as const satisfies Record<MessageV2.ResearchEffort, number>
const childSlots = new HierarchicalSemaphore(MAX_CHILD_AGENTS)
const configuredComputeCap = Number(process.env.OPENSCIENCE_MAX_COMPUTE_SUBAGENTS)
const MAX_COMPUTE_SUBAGENTS =
  Number.isFinite(configuredComputeCap) && configuredComputeCap >= 1 ? Math.floor(configuredComputeCap) : 2
const computeSlots = new HierarchicalSemaphore(MAX_COMPUTE_SUBAGENTS)

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.enum(DELEGATION_PROFILES).describe("The internal explore, execute, or review profile"),
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

export type TaskOutcome = {
  outcome: "completed" | "partial" | "timed_out" | "error"
  stopReason: "completed" | "max_steps" | "tool_failures" | "wall_clock" | "provider_error"
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
      const started = Date.now()
      const effort = MessageV2.resolveResearchEffort(ctx.extra?.effort)
      const maxConcurrentChildren = MessageV2.childAgentLimit(effort)
      const budgetMs = TASK_WALL_CLOCK_MS[effort]

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Internal delegation profile ${params.subagent_type} is unavailable`)

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
      const assistant = msg.info
      const dispatch = await (async () => {
        using _ = await Lock.write(`task-dispatch:${ctx.sessionID}:${assistant.parentID}`)
        const messages = await Session.messages({ sessionID: ctx.sessionID })
        return taskDispatchBudget(messages, assistant.parentID, ctx.callID, effort)
      })()

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id)
          return assertTaskContinuation({
            session: found,
            parentSessionID: ctx.sessionID,
            projectID: Instance.project.id,
          })
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: childPermissionRules(config.experimental?.primary_tools),
        })
      })
      const budgetStartedAt = Date.now()
      const budgetDeadlineAt = budgetStartedAt + budgetMs
      const budgetAbort = AbortSignal.timeout(budgetMs)
      const childAbort = AbortSignal.any([ctx.abort, budgetAbort])

      // Per-turn dispatch limits already keep Normal at two children and Ultra
      // at four. The shared pool is only a machine-wide safety ceiling; adding
      // a second process-global Normal pool made unrelated projects consume one
      // another's effort budget during concurrent research.
      const releaseChildSlot = await childSlots.acquire(session.id, { parent: ctx.sessionID, signal: childAbort })
      using _childSlot = defer(() => releaseChildSlot())

      // A nested compute agent takes over its waiting parent's permit. Parallel
      // nested siblings serialize on that lease, so nesting cannot bypass the
      // global cap and a full pool cannot deadlock on permits held by parents.
      const releaseComputeSlot = isComputeDelegationProfile(agent.name)
        ? await computeSlots.acquire(session.id, { parent: ctx.sessionID, signal: childAbort })
        : undefined
      using _computeSlot = defer(() => releaseComputeSlot?.())
      const activeStartedAt = Date.now()
      const queuedMs = activeStartedAt - budgetStartedAt

      const model = await (async () => {
        if (agent.model) return agent.model
        return { modelID: assistant.modelID, providerID: assistant.providerID }
      })()

      ctx.metadata({
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
          queuedMs,
          activeStartedAt,
        },
      })

      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
            sessionId: session.id,
            model,
            startedAt: started,
            elapsedMs: Date.now() - started,
            effort,
            maxConcurrentChildren,
            maxGlobalChildren: MAX_CHILD_AGENTS,
            taskDispatch: dispatch.dispatch,
            maxTaskDispatches: dispatch.limit,
            budgetMs,
            queuedMs,
            activeStartedAt,
          },
        })
      })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const previous = new Set((await Session.messages({ sessionID: session.id })).map((message) => message.info.id))
      const handoff = await materializeTaskToolOutputs({
        prompt: params.prompt,
        parentSessionID: ctx.sessionID,
        childSessionID: session.id,
      })
      const promptParts = await SessionPrompt.resolvePromptParts(handoff.prompt)
      const childReminder = {
        type: "text" as const,
        text: [
          "<system-reminder>",
          `Research effort is ${effort.toUpperCase()}. Complete this one bounded assignment and return natural, concise findings to the lead Research agent.`,
          "Do not create child tasks. Load a domain skill only when it materially improves this assignment.",
          "</system-reminder>",
        ].join("\n"),
      }

      const deadline = await withTaskDeadline(
        () =>
          SessionPrompt.prompt({
            messageID,
            sessionID: session.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            agent: agent.name,
            effort,
            tools: {
              todowrite: false,
              todoread: false,
              task: false,
              ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
            },
            parts: [childReminder, ...promptParts],
          }),
        () => SessionPrompt.cancel(session.id),
        Math.max(1, budgetDeadlineAt - Date.now()),
      ).finally(() => {
        unsub()
      })
      if (deadline.error && !deadline.timedOut) throw deadline.error

      await Session.flushPendingParts(session.id)
      const messages = await Session.messages({ sessionID: session.id })
      const { summary, usage } = summarizeTurn(messages, previous)
      const fallback = messages
        .filter((message) => !previous.has(message.info.id) && message.info.role === "assistant")
        .flatMap((message) => message.parts.filter((part): part is MessageV2.TextPart => part.type === "text"))
        .findLast((part) => part.text.trim().length > 0)?.text
      const text = deadline.result?.parts.findLast((part) => part.type === "text")?.text ?? fallback ?? ""
      const child = deadline.result?.info.role === "assistant" ? deadline.result.info : undefined
      const failedToolCalls = summary.filter((part) => part.state.status === "error").length
      const taskOutcome = classifyTaskOutcome({
        timedOut: deadline.timedOut,
        finish: child?.finish,
        error: child?.error,
        toolCalls: summary.length,
        failedToolCalls,
      })
      const body =
        text ||
        (deadline.timedOut
          ? `No textual findings were emitted before the cutoff. The child completed ${summary.length} tool calls in this turn.`
          : taskOutcome.outcome === "error"
            ? `The child failed before emitting textual findings after ${summary.length} tool calls in this turn.`
            : "")

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
        body,
        "",
        `<task_metadata>${JSON.stringify({ session_id: session.id, profile: agent.name, effort, outcome: taskOutcome.outcome, stop_reason: taskOutcome.stopReason, timed_out: deadline.timedOut, budget_ms: budgetMs, queued_ms: queuedMs, active_ms: Math.max(0, Date.now() - activeStartedAt) })}</task_metadata>`,
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          model,
          durationMs: Date.now() - started,
          toolCalls: summary.length,
          failedToolCalls,
          usage,
          effort,
          maxConcurrentChildren,
          maxGlobalChildren: MAX_CHILD_AGENTS,
          taskDispatch: dispatch.dispatch,
          maxTaskDispatches: dispatch.limit,
          budgetMs,
          timedOut: deadline.timedOut,
          queuedMs,
          activeMs: Math.max(0, Date.now() - activeStartedAt),
          outcome: taskOutcome.outcome,
          stopReason: taskOutcome.stopReason,
        },
        output,
      }
    },
  }
})
