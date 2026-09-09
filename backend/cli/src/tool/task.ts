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
import { SubtaskAttachments } from "@/session/subtask-attachments"
import { SessionWorkspace } from "@/session/workspace"
import { TaskEvidence } from "./task-evidence"
import { PayloadIntegrity } from "./payload-integrity"
import { CredentialRevocation } from "@/credentials/revocation"
import { Fusion } from "@/session/fusion"

export const DELEGATION_PROFILES = ["explore", "execute"] as const
export const DELEGATION_SPECIALISTS = ["biology", "physics", "ml"] as const
export function isComputeDelegationProfile(name: string) {
  return name === "execute"
}

/** Placeholder session ids models eagerly emit for the optional `session_id`
 * field. Every one of them unambiguously means "start a new child". */
const CONTINUATION_PLACEHOLDER = /^ses_(?:new|none|null|undefined|placeholder|current|parent)$/i

export type TaskContinuation = { kind: "new" } | { kind: "continue"; sessionID: string }

/**
 * The single continuation classifier shared by schema normalization, dispatch
 * and restart recovery. It does not load a session: an omitted, empty,
 * placeholder, or self-referential value is a new child; any other `ses_` id is
 * a continuation candidate that dispatch/recovery must still authorize as a
 * direct child before reusing it.
 */
export function classifyTaskContinuation(value: unknown, parentSessionID: string): TaskContinuation {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed || trimmed === parentSessionID) return { kind: "new" }
  if (CONTINUATION_PLACEHOLDER.test(trimmed)) return { kind: "new" }
  return { kind: "continue", sessionID: trimmed }
}

export function taskContinuationID(value: string | null | undefined, parentSessionID: string) {
  const continuation = classifyTaskContinuation(value, parentSessionID)
  return continuation.kind === "continue" ? continuation.sessionID : undefined
}

/** A pre-dispatch continuation failure. Its message is written for the model:
 * it never created a child and it names the exact recovery (omit `session_id`,
 * or reuse one of this session's real child tasks). */
export class TaskContinuationError extends Error {
  constructor(
    readonly parentSessionID: string,
    readonly requested: string,
    message: string,
  ) {
    super(message)
    this.name = "TaskContinuationError"
  }
}

/**
 * Resolve a model-supplied `session_id` to a reusable child, or fail before any
 * child work is dispatched. Placeholders and the calling session itself resolve
 * to a new child (undefined). A real id is accepted only when it is a direct
 * child of the calling session in this project; anything else — an invented
 * suffix, a bare `ses_`, a foreign or stale id — raises a typed error that tells
 * the model to omit `session_id` or reuse one of this session's actual children.
 * A stale id never silently spawns duplicate work.
 */
export async function resolveTaskContinuation(input: {
  requested: unknown
  parentSession: Session.Info
  projectID: string
}): Promise<Session.Info | undefined> {
  const continuation = classifyTaskContinuation(input.requested, input.parentSession.id)
  if (continuation.kind === "new") return undefined
  const session = await Session.get(continuation.sessionID).catch((error) => {
    if (Storage.NotFoundError.isInstance(error)) return undefined
    throw error
  })
  if (session && session.projectID === input.projectID && session.parentID === input.parentSession.id) {
    return session
  }
  const children = (await Session.children(input.parentSession.id)).filter(
    (child) => child.projectID === input.projectID,
  )
  const reusable = children.map((child) => `${child.id} (${child.title})`)
  const recovery = reusable.length
    ? `Omit session_id to start a new task, or reuse one of: ${reusable.join("; ")}`
    : "Omit session_id to start a new task. This session has started no child tasks to continue yet"
  throw new TaskContinuationError(
    input.parentSession.id,
    continuation.sessionID,
    `No child session ${continuation.sessionID} exists for this session. No child was started. ${recovery}.`,
  )
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
    .trim()
    .regex(/^(?:ses_.*)?$/, "Expected an exact child sessionId or an empty value for new work")
    .nullish()
    .overwrite((value) => value || undefined)
    .describe(
      "Omit, null or empty for new work. Continue only an exact child sessionId returned by Task; never invent a suffix or use the parent ID.",
    ),
  command: z.string().describe("The command that triggered this task").optional(),
})

/** Canonicalize model-supplied continuation placeholders before a Task attempt
 * is fingerprinted. Execution and restart recovery must use the same input or
 * an interrupted, already-completed child can permanently poison its parent. */
export function normalizeTaskAttemptInput(
  input: unknown,
  parentSessionID: string,
  messages: MessageV2.WithParts[] = [],
) {
  const parsed = parameters.parse(input)
  PayloadIntegrity.assert({ content: parsed.prompt, before: "", messages })
  return {
    ...parsed,
    session_id: taskContinuationID(parsed.session_id, parentSessionID),
  }
}

export function childPermissionRules(primaryTools: string[] = []): PermissionNext.Ruleset {
  return [
    ...primaryTools.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "question", pattern: "*", action: "deny" },
    { permission: "todowrite", pattern: "*", action: "deny" },
    { permission: "todoread", pattern: "*", action: "deny" },
  ]
}

export function assertLeadDelegationSession(session: Session.Info) {
  if (session.parentID) {
    throw new Error(
      `Only the lead Research session may dispatch Task workers. Child session ${session.id} must return follow-up recommendations to its lead.`,
    )
  }
  return session
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

function taskToolStatus(part: MessageV2.ToolPart) {
  if (part.tool === "research_search" && part.state.status === "completed") {
    const metadata = part.state.metadata
    // An unavailable search is a closed failed attempt. Its provider-level
    // partial receipt does not mean an operation is still running at handoff.
    if (
      metadata?.outcome === "partial" &&
      (metadata.stopReason === "search_unavailable" || metadata.stopReason === "search_output_unavailable")
    ) {
      return "error" as const
    }
  }
  return observableToolStatus(part)
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
        status: taskToolStatus(part),
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

/** Only text after the final assistant message's last tool is a handoff.
 * Earlier narration cannot establish completion of later work. */
export function taskText(messages: MessageV2.WithParts[], previous: Set<string>) {
  const text = (parts: readonly MessageV2.Part[]) =>
    parts
      .filter(
        (part): part is MessageV2.TextPart => part.type === "text" && !part.ignored && part.text.trim().length > 0,
      )
      .toSorted((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0) || a.id.localeCompare(b.id))
      .map((part) => part.text.trim())
      .join("\n\n")
  const final = messages
    .filter((message) => !previous.has(message.info.id) && message.info.role === "assistant")
    .toSorted((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
    .at(-1)
  if (!final) return ""
  const lastTool = final.parts.findLastIndex((part) => part.type === "tool")
  return text(final.parts.slice(lastTool + 1))
}

export type TaskOutcome = {
  outcome: "completed" | "partial" | "error"
  stopReason:
    "completed" | "max_steps" | "tool_failures" | "tool_partial" | "provider_error" | "cancelled" | "empty_handoff"
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
  partialToolCalls?: number
}): TaskOutcome {
  if (
    MessageV2.AbortedError.isInstance(input.error) ||
    CredentialRevocation.interruption(input.error) !== undefined ||
    (input.error instanceof Error && input.error.name === "AbortError")
  ) {
    return { outcome: "partial", stopReason: "cancelled" }
  }
  if (input.error || input.finish === "content-filter") {
    return { outcome: input.hasText ? "partial" : "error", stopReason: "provider_error" }
  }
  if (input.finish === "max-steps") return { outcome: "partial", stopReason: "max_steps" }
  if (input.partialToolCalls) return { outcome: "partial", stopReason: "tool_partial" }
  if (input.toolCalls && input.failedToolCalls === input.toolCalls) {
    return { outcome: "partial", stopReason: "tool_failures" }
  }
  if (!input.hasText) {
    return { outcome: input.toolCalls ? "partial" : "error", stopReason: "empty_handoff" }
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
      const leadSession = assertLeadDelegationSession(await Session.get(ctx.sessionID))
      const config = await Config.get()
      const effort = MessageV2.resolveResearchEffort(ctx.extra?.effort)
      const configured = MessageV2.resolveDelegationSettings(ctx.extra?.delegationSettings, { effort })
      const settings =
        configured.level === "off" && ctx.extra?.bypassAgentCheck
          ? { ...configured, level: "light" as const }
          : configured
      // Some models eagerly fill every optional schema field with the current
      // session or a `ses_new` placeholder. Those values unambiguously mean a
      // new child; a real id must be a direct child of this session or dispatch
      // fails with an actionable typed error rather than a raw storage failure.
      const attemptInput = normalizeTaskAttemptInput(params, ctx.sessionID)
      const attachments = MessageV2.SubtaskAttachment.array().parse(ctx.extra?.attachments ?? [])
      const continuation = await resolveTaskContinuation({
        requested: params.session_id,
        parentSession: leadSession,
        projectID: Instance.project.id,
      })
      const continuationID = continuation?.id

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
      const leadModel = { modelID: assistant.modelID, providerID: assistant.providerID }
      const configuredWorker = settings.workerModel ?? agent.model ?? leadModel
      // Fusion binds the lead to one persistent execute worker. Resolution is
      // serialized per lead and lands before the attempt is reserved, so two
      // dispatches in one step share the worker and a restart finds the same
      // binding. An explicit session_id naming another child is an ordinary
      // continuation; one naming the bound worker is a Fusion handoff.
      const fusion =
        settings.strategy === "fusion" && params.subagent_type === "execute"
          ? await Fusion.exclusive(
              ctx.sessionID,
              async () => {
                const bound = await Fusion.get(ctx.sessionID)
                if (continuation && continuation.id !== bound?.workerSessionID) return undefined
                const existing = await TaskAttempt.read(identity)
                if (existing?.childSessionID && bound && bound.workerSessionID === existing.childSessionID) {
                  // A retried or resumed attempt keeps the worker it already had.
                  return { binding: bound, fresh: false }
                }
                if (continuation && bound && !Fusion.same(bound.worker, configuredWorker)) {
                  // The model insists on the previous worker while the preference
                  // now names another model: honour the request as an ordinary
                  // continuation instead of forking a new lineage under it.
                  return undefined
                }
                return Fusion.resolve({
                  parentSessionID: ctx.sessionID,
                  userMessageID: assistant.parentID,
                  worker: configuredWorker,
                  mint: () => Identifier.descending("session"),
                })
              },
              ctx.abort,
            )
          : undefined
      const reserved = await TaskAttempt.reserve({
        ...identity,
        fingerprint: TaskAttempt.fingerprint(attachments.length ? { ...attemptInput, attachments } : attemptInput),
        ...(!attachments.length && { legacyFingerprint: TaskAttempt.legacyFingerprint(attemptInput) }),
        childSessionID: continuationID ?? fusion?.binding.workerSessionID,
      })
      const started = reserved.createdAt

      await using attemptLease = await TaskAttempt.acquire(identity, Number.POSITIVE_INFINITY, ctx.abort)
      return await attemptLease.during(async () => {
        const current = await TaskAttempt.read(identity)
        if (!current) throw new Error(`Durable Task attempt ${ctx.callID} disappeared after reservation`)
        if (current.status === "completed" && current.result) return current.result
        PayloadIntegrity.assert({ content: attemptInput.prompt, before: "", messages: ctx.messages })

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
              title: fusion
                ? `Fusion worker (lineage ${fusion.binding.generation})`
                : params.description +
                  (params.specialist
                    ? ` (@${params.specialist} specialist, ${params.subagent_type} phase)`
                    : ` (@${params.subagent_type} subagent)`),
              permission: childPermissionRules(config.experimental?.primary_tools),
            })
        // Project-mode parents have no private scratch to hand off. Their
        // children keep isolated outputs and the existing project read policy.
        if ((await SessionWorkspace.get(ctx.sessionID)).mode === "isolated") {
          await SessionFilesystem.grantTaskHandoff({
            parentSessionID: ctx.sessionID,
            childSessionID: session.id,
          })
        }

        // The binding's model is the one that runs: a preference change starts a
        // new lineage in Fusion.resolve rather than re-routing this worker.
        const model = fusion ? fusion.binding.worker : configuredWorker
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
        const fusionMetadata = fusion
          ? {
              fusion: {
                generation: fusion.binding.generation,
                handoff: fusion.binding.turn?.handoffs ?? 1,
                lineageHandoffs: fusion.binding.handoffs,
                worker: fusion.binding.worker,
              },
            }
          : {}
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
            ...fusionMetadata,
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
            const hasTool = MessageV2.hasLocalToolResult(message.parts)
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
                      status: taskToolStatus(part),
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

                ctx.abort.throwIfAborted()
                const exists = messages.some(
                  (message) => message.info.role === "user" && message.info.id === reserved.childMessageID,
                )
                const childGuidance = [
                  `You own one ${params.subagent_type} phase${params.specialist ? ` with the ${params.specialist} specialist` : ""} for the lead Research agent. The assignment in the user message is authoritative.`,
                  "Work independently on that phase and load a domain skill only when useful. You cannot dispatch workers; recommend any worthwhile follow-up to the lead in your handoff.",
                  "Do not return a diary of searches, reads, or commands. Your final response is a decision-ready handoff to the lead, not a second user-facing report.",
                  "Use only the Markdown sections that carry substance: Outcome; Findings; Evidence; Changes / outputs; Limitations; Next action.",
                  "Preserve exact paths, identifiers, numeric results, commands, and error strings when they matter. Distinguish observed evidence from inference. If blocked or partial, say exactly what remains.",
                  'Save important scratch outputs with artifact(action="save_file", path=...) before returning. The lead receives immutable artifact/version handles and can read them without access to your private scratch. A saved file proves an output exists, not that its claims or tests passed.',
                  "Do not wrap the response in XML or JSON and do not restate these instructions.",
                  settings.autonomy === "interactive"
                    ? "If the assignment contains a genuinely consequential ambiguity, return one precise question to the lead instead of guessing."
                    : settings.autonomy === "autonomous"
                      ? "Resolve ordinary ambiguities independently within the current permission boundary; surface only decisions that materially affect the result."
                      : "Resolve routine ambiguities independently and flag consequential assumptions in the handoff.",
                  ...(fusion
                    ? [Fusion.workerContract(fusion.binding.generation, fusion.binding.turn?.handoffs ?? 1)]
                    : []),
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
                    delegationSettings: { ...settings, level: "off" },
                    system: childGuidance,
                    tools: {
                      todowrite: false,
                      todoread: false,
                      question: false,
                      task: false,
                      ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
                    },
                    parts: [
                      ...(await SessionPrompt.resolvePromptParts(transfer.prompt)),
                      ...(await SubtaskAttachments.materialize(attachments, session.id, ctx.abort)),
                    ],
                  })
                }
                // Keep progress and cancellation connected until the child settles.
                return await SessionPrompt.withCancellation(session.id, run, ctx.abort).then(
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
        const evidence = await TaskEvidence.collect({
          projectID: Instance.project.id,
          sessionID: session.id,
          messages: complete,
          previous,
        })
        const child = execution.result?.info.role === "assistant" ? execution.result.info : terminal?.info
        const failedToolCalls = summary.filter((part) => part.state.status === "error").length
        const partialToolCalls = summary.filter((part) => part.state.status === "partial").length
        const taskOutcome = classifyTaskOutcome({
          finish: child?.finish,
          error: execution.error ?? child?.error,
          hasText: text.trim().length > 0,
          toolCalls: summary.length,
          failedToolCalls,
          partialToolCalls,
        })
        const raw =
          text ||
          (taskOutcome.outcome === "error"
            ? `The child failed before emitting textual findings after ${summary.length} tool calls in this turn.`
            : `The child stopped before emitting textual findings after ${summary.length} tool calls in this turn.`)
        const handoff = taskHandoff(raw)
        const activeMs = timing.activeMs
        // Surface the durable child id in the model-visible output (not only in
        // metadata) so the lead can continue this exact worker via `session_id`.
        // Compaction preserves it: MessageV2.toolSummary re-emits it from metadata.
        const output = [
          `Task session ${session.id}: ${taskOutcome.outcome} (${taskOutcome.stopReason}). Reuse this sessionId to continue the same worker.`,
          ...(taskOutcome.stopReason === "max_steps"
            ? ["[Child reached its bounded step limit; partial result follows.]"]
            : taskOutcome.stopReason === "tool_failures"
              ? ["[Every child tool call failed; treat the following as a partial, blocked result.]"]
              : taskOutcome.stopReason === "tool_partial"
                ? ["[One or more child tool operations remain partial or unsettled; treat this as a partial result.]"]
                : taskOutcome.stopReason === "provider_error"
                  ? ["[Child stopped on a provider error; its usable partial result follows.]"]
                  : taskOutcome.stopReason === "cancelled"
                    ? ["[Child was cancelled; completed actions and usable partial evidence follow.]"]
                    : taskOutcome.stopReason === "empty_handoff"
                      ? ["[Child ended without a textual handoff; treat this result as incomplete.]"]
                      : failedToolCalls > 0
                        ? [
                            `[Child returned a completed handoff with ${failedToolCalls} failed tool ${failedToolCalls === 1 ? "attempt" : "attempts"}. Review its limitations; the failed attempts remain recorded in the child session.]`,
                          ]
                        : []),
          handoff.text,
          TaskEvidence.describe(evidence),
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
            partialToolCalls,
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
            evidence,
            ...fusionMetadata,
          },
          output,
        })
        await TaskAttempt.complete({ ...identity, result })
        if (fusion) {
          await Fusion.settle({
            parentSessionID: ctx.sessionID,
            callID: identity.callID,
            outcome: taskOutcome.outcome,
            stopReason: taskOutcome.stopReason,
            usage,
          })
        }
        return result
      })
    },
  }
})
