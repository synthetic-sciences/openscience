import { SubagentResult } from "../session/subagent-result"
import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { observableToolStatus } from "@/session/tool-outcome"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "@/project/instance"
import { TaskAttempt } from "./task-attempt"
import { Storage } from "@/storage/storage"
import { SubtaskAttachments } from "@/session/subtask-attachments"
import { TaskEvidence } from "./task-evidence"
import { PayloadIntegrity } from "./payload-integrity"
import { CredentialRevocation } from "@/credentials/revocation"
import { Log } from "@/util/log"
import { FileLease } from "@/util/file-lease"
import { SessionWake } from "@/session/wake"
import { SubagentBudget } from "@/session/subagent-budget"
import { SubagentDispatch } from "@/session/subagent-dispatch"
import { Provider } from "@/provider/provider"
import { resolveAccessRoute } from "@/session/access-route"
import { Question } from "@/question"
import { headless } from "./question"
import { Flag } from "@/flag/flag"
import { formatUsd } from "@synsci/util/money"

const log = Log.create({ service: "tool.task" })

/** Whether someone can answer a question in this session: a client that shows
 * questions, not a headless run that answers them itself, and not a session
 * that denies the question tool (`openscience run` without --auto-approve). */
/** The conversation that owns a session's subagent budget: its top-level ancestor. */
async function rootSession(id: string): Promise<string> {
  const info = await Session.get(id)
  return info.parentID ? rootSession(info.parentID) : id
}

async function answerable(sessionID: string) {
  if (!["app", "cli", "desktop"].includes(Flag.OPENSCIENCE_CLIENT)) return false
  if (await headless(sessionID)) return false
  const permission = await Session.get(sessionID)
    .then((session) => session.permission)
    .catch(() => undefined)
  return !permission || PermissionNext.evaluate("question", "*", permission).action !== "deny"
}

/** Placeholder session ids models eagerly emit for the optional `task_id`
 * field. Every one of them unambiguously means "start a new child". */
const CONTINUATION_PLACEHOLDER = /^(?:ses_)?(?:new|none|null|undefined|placeholder|current|parent|fresh)$/i

/** What the lead should do after a runtime limit stop. Under Interactive and
 * Balanced independence the user decides whether to fund more work: the task
 * asks once and waits up to `ASK_TIMEOUT_MS`. Under Autonomous, in a headless
 * run, or when no one answers in time, the lead finishes the remaining work
 * itself instead of waiting. No path starts a replacement worker, which would
 * sidestep the worker's limit. */
export namespace TaskLimit {
  export const ASK_TIMEOUT_MS = 5 * 60_000
  export type Choice = "more" | "finish" | "timeout" | "dismissed"

  const ask = (action: string) =>
    `If the saved partial result already answers the request, answer from it and say what is missing. Otherwise do not redo the remaining work yourself or start a replacement worker: end your turn and tell the user what the worker finished, what remains and what it used, and that they can ${action} from the worker card. Continue with this task_id only when the user asks.`
  const proceed = (why: string) =>
    `${why} Do not wait for the user, start a replacement worker or continue this task_id. Build on the saved partial result, finish the remaining work yourself, and say in your final answer that the worker stopped early and which part you completed instead.`
  const stopped = (reason: string) => reason === "budget_limit" || reason === "token_limit" || reason === "deadline"

  export function guidance(reason: string, autonomy?: MessageV2.DelegationSettings["autonomy"]) {
    if (stopped(reason) && autonomy === "autonomous")
      return proceed("Independence is autonomous, so no one is available to extend this worker.")
    if (reason === "budget_limit" || reason === "token_limit") return ask("add budget and continue it")
    if (reason === "deadline") return ask("continue it with a new deadline")
    if (reason === "deadline_wrapup")
      return "Continue with this task_id under a new assignment deadline if more work is needed."
    if (reason === "cancelled") return "Continue with this task_id only if the stopped work is requested again."
    return "Continue with this task_id only after an allowance is available."
  }

  /** Ask the user, when someone can answer, and turn the answer into the lead's next step. */
  export async function resolve(input: {
    reason: string
    autonomy?: MessageV2.DelegationSettings["autonomy"]
    /** Whether anyone can answer: false for headless runs and clients without questions. */
    attended: boolean
    /** The amount the pool can still grant this worker without a user increase, formatted, when that covers more work. */
    remaining?: string
    ask: () => Promise<Choice>
    /** Raise the conversation's subagent budget; resolves to the amount added, for the lead. */
    raise: () => Promise<string>
  }) {
    const next =
      "Continue this worker with this task_id if the remaining work still needs it; otherwise finish it yourself from the saved partial result. Do not start a replacement worker."
    if (input.remaining && (input.reason === "budget_limit" || input.reason === "token_limit"))
      return `The worker used its own share, but the conversation's subagent budget still has ${input.remaining} available, so no approval is needed. ${next}`
    if (!stopped(input.reason) || input.autonomy === "autonomous") return guidance(input.reason, input.autonomy)
    if (!input.attended) return proceed("No one is available to answer in this run.")
    const choice = await input.ask()
    if (choice === "timeout")
      return proceed(
        `No one answered within ${ASK_TIMEOUT_MS / 60_000} minutes, so the run continues without this worker.`,
      )
    if (choice === "finish") return proceed("The user chose to finish without this worker.")
    if (choice === "dismissed") return guidance(input.reason, input.autonomy)
    if (input.reason === "deadline") return `The user allowed this worker more time. ${next}`
    return input.raise().then(
      (amount) => `The user added ${amount} to the subagent budget. ${next}`,
      (error: unknown) =>
        `The user approved more budget, but the increase failed: ${error instanceof Error ? error.message : String(error)}. ${ask("add budget and continue it")}`,
    )
  }
}

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
 * it never created a child and it names the exact recovery (omit `task_id`,
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
 * Resolve a model-supplied `task_id` to a reusable child, or fail before any
 * child work is dispatched. A real id is accepted only when it is a direct
 * child of the calling session in this project; anything else raises a typed
 * error that tells the model to omit `task_id` or reuse one of this session's
 * actual children. A stale id never silently spawns duplicate work.
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
    ? `Omit task_id to start a new task, or reuse one of: ${reusable.join("; ")}`
    : "Omit task_id to start a new task. This session has started no child tasks to continue yet"
  throw new TaskContinuationError(
    input.parentSession.id,
    continuation.sessionID,
    `No child session ${continuation.sessionID} exists for this session. No child was started. ${recovery}.`,
  )
}

const parameters = z.object({
  description: z.string().describe("A short title for the worker session"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The name of the subagent to use for this task"),
  task_id: z
    .string()
    .trim()
    .nullish()
    .overwrite((value) => value || undefined)
    .describe("Reuse a returned task_id to continue the same child with its saved messages."),
  command: z.string().describe("The command that triggered this task").optional(),
  expected_output: z.string().min(1).optional().describe("Expected artifacts, findings and checks"),
  allocation: z
    .object({ usd: z.number().positive().optional(), tokens: z.number().int().positive().optional() })
    .optional()
    .describe("Allocation from the approved shared pool; cannot raise its total"),
  background: z.boolean().optional().describe("Return immediately; completion notifies you. Do not poll or sleep."),
})

/** Canonicalize model-supplied continuation placeholders before a Task attempt
 * is fingerprinted. Execution and restart recovery must use the same input or
 * an interrupted, already-completed child can permanently poison its parent. */
export function normalizeTaskAttemptInput(
  input: unknown,
  parentSessionID: string,
  messages: MessageV2.WithParts[] = [],
) {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  // Older persisted calls named the continuation `session_id`.
  const parsed = parameters.parse({ ...raw, task_id: raw.task_id ?? raw.session_id })
  PayloadIntegrity.assert({ content: parsed.prompt, before: "", messages })
  return {
    ...parsed,
    task_id: taskContinuationID(parsed.task_id, parentSessionID),
  }
}

/** Denies a child inherits unless the subagent's own ruleset allows the tool:
 * workers do not keep todo lists or dispatch further workers by default, and
 * never ask the user directly. A lead's own session rules that deny a tool or
 * gate a directory come first, so a worker can never do what the person told
 * the lead not to do. */
export function childPermissionRules(
  agent: Agent.Info,
  primaryTools: string[] = [],
  parent: PermissionNext.Ruleset = [],
): PermissionNext.Ruleset {
  const allows = (tool: string) => agent.permission.some((rule) => rule.permission === tool && rule.action !== "deny")
  return [
    ...parent.filter((rule) => rule.action === "deny" || rule.permission === "external_directory"),
    ...(allows("todowrite") ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" as const }]),
    ...(allows("task") ? [] : [{ permission: "task", pattern: "*", action: "deny" as const }]),
    { permission: "question", pattern: "*", action: "deny" },
    ...primaryTools.map((permission) => ({ permission, pattern: "*", action: "deny" as const })),
  ]
}

export function assertTaskContinuation(input: { session: Session.Info; parentSessionID: string; projectID: string }) {
  if (input.session.projectID !== input.projectID || input.session.parentID !== input.parentSessionID) {
    throw new Error(
      `Task continuation session ${input.session.id} is not a direct child of the calling session ${input.parentSessionID}. Use only the exact task_id returned by an earlier successful Task call from this session.`,
    )
  }
  return input.session
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
    | "completed"
    | "max_steps"
    | "tool_failures"
    | "tool_partial"
    | "provider_error"
    | "cancelled"
    | "empty_handoff"
    | SubagentBudget.Reason
    | "reported_incomplete"
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

/** Briefs whose deliverable is a push, release or upload. Workers cannot
 * reach the user's approvals or publishing credentials; the lead does that. */
export function publishingBrief(text: string) {
  return /\b(?:git\s+push|push(?:\s+\S+){0,3}\s+to\s+(?:github|origin|the\s+remote|remote)|hf\s+upload|huggingface-cli\s+upload|upload(?:\s+\S+){0,4}\s+to\s+(?:hugging\s*face|hf|github)|gh\s+(?:release|pr)\s+create|npm\s+publish|twine\s+upload|(?:open|create|cut)\s+(?:a\s+|the\s+)?(?:pr|pull\s+request|release))\b/i.test(
    text,
  )
}

export type TaskState = "running" | "completed" | "error"

/** The model-facing result: OpenCode's `<task>` envelope. An error state still
 * carries the child's partial text so the lead can continue from it. */
export function renderTaskOutput(input: { sessionID: string; state: TaskState; summary?: string; text: string }) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "Do not sleep, poll for progress, ask the task for status, or duplicate its work; avoid the files and topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  "When you end a response while this worker is still running, say so in one line and say that its report will arrive as a new turn; do not describe work that depends on its result as done.",
].join("\n")

/** Background children in flight, by child session id, so a completion can
 * wake the parent exactly once and a second call can find the first. `result`
 * never rejects; `delivered` records a successful wait, so a cancelled waiter
 * cannot suppress the completion wake-up. */
type Background = {
  parentID: string
  controller: AbortController
  result: Promise<TaskAttempt.Result>
  delivered: boolean
  parentStopped: boolean
}
const background = new Map<string, Background>()

export function cancelBackgroundTasks(parentID: string) {
  for (const [childID, entry] of background) {
    if (entry.parentID !== parentID) continue
    entry.parentStopped = true
    entry.controller.abort(new SubagentBudget.LimitError("cancelled"))
    cancelBackgroundTasks(childID)
  }
}

export function backgroundTasks() {
  return background.size
}

const JOINED =
  "Waited for this background worker to finish; its report follows. The new brief was not sent to it: resume with this task_id if a follow-up is still needed."

/** Wait for a running background child, or stop when the caller's turn does. */
function join(entry: Background, abort: AbortSignal) {
  return new Promise<TaskAttempt.Result>((resolve, reject) => {
    const waiting = { active: true }
    const cancel = () => {
      waiting.active = false
      abort.removeEventListener("abort", cancel)
      reject(new Error("Waiting for the background worker was cancelled with the turn."))
    }
    if (abort.aborted) return cancel()
    abort.addEventListener("abort", cancel, { once: true })
    entry.result.then((result) => {
      if (!waiting.active) return
      waiting.active = false
      abort.removeEventListener("abort", cancel)
      entry.delivered = true
      resolve(result)
    }, reject)
  })
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = (await Agent.list()).filter((agent) => agent.mode !== "primary")
  // A caller's ruleset can forbid specific subagents.
  const caller = ctx?.agent
  const accessible = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessible
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    // Older callers named the continuation `session_id`; keep honouring it so
    // an invented id under the old name is refused rather than ignored.
    normalizeInput(args: unknown) {
      if (!args || typeof args !== "object" || Array.isArray(args)) return args
      const record = args as Record<string, unknown>
      if (!("session_id" in record)) return args
      const { session_id, ...rest } = record
      return { ...rest, task_id: rest.task_id ?? session_id }
    },
    async execute(params: z.infer<typeof parameters>, ctx) {
      const entered = Date.now()
      if (publishingBrief(`${params.description}\n${params.prompt}`)) {
        throw new Error(
          "Publishing stays with the lead: pushes, releases and uploads use this session's approvals and credentials. Delegate preparation or verification if useful, then push or upload from here.",
        )
      }
      const config = await Config.get()
      const parent = await Session.get(ctx.sessionID)
      const depth = await SessionPrompt.sessionDepth(parent)
      const limit = config.subagent_depth ?? 1
      if (depth >= limit) {
        throw new Error(
          `Subagent depth limit reached (${limit}). This session is already a worker; return your findings to the lead instead of dispatching further workers. Increase "subagent_depth" in openscience.json to allow nesting.`,
        )
      }

      const attemptInput = normalizeTaskAttemptInput(params, ctx.sessionID)
      const attachments = MessageV2.SubtaskAttachment.array().parse(ctx.extra?.attachments ?? [])
      // The normalized input also honours the retired `session_id` name, so an
      // invented id under either name is refused before any child starts.
      const continuation = await resolveTaskContinuation({
        requested: attemptInput.task_id,
        parentSession: parent,
        projectID: Instance.project.id,
      })

      // A task_id naming a background worker still at work is a request for
      // its result. Prompting that session mid-turn would abort the turn and
      // return an empty "provider error"; wait for the report instead, and
      // deliver it here once.
      const running = continuation ? background.get(continuation.id) : undefined
      if (running) {
        const result = await join(running, ctx.abort)
        return { ...result, output: `${JOINED}\n${result.output}` }
      }
      // A foreground run (or a user continuation) of this child is still going: say so, rather than
      // starting a second run whose refusal would be reported as a provider error.
      if (continuation) {
        try {
          SessionPrompt.assertNotBusy(continuation.id)
        } catch (error) {
          if (!(error instanceof Session.BusyError)) throw error
          throw new Error(
            `Subagent ${continuation.id} is still running; wait for its report, or omit task_id to start a new task.`,
          )
        }
      }

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

      const next = await Agent.get(params.subagent_type)
      if (!next || next.mode === "primary") {
        const names = accessible.map((a) => a.name).join(", ")
        throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid subagent. Available: ${names}`)
      }
      const agent = next

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
      const effort = MessageV2.resolveResearchEffort(ctx.extra?.effort)
      const settings = MessageV2.resolveDelegationSettings(ctx.extra?.delegationSettings, { effort })
      const leadModel = { modelID: assistant.modelID, providerID: assistant.providerID }
      const userLimits = SubagentBudget.settings((await Config.getGlobal()).subagents)
      const reserved = await TaskAttempt.reserve({
        ...identity,
        fingerprint: TaskAttempt.fingerprint(attachments.length ? { ...attemptInput, attachments } : attemptInput),
        childSessionID: continuation?.id,
      })
      const part = (await MessageV2.parts(ctx.messageID)).find(
        (part) => part.type === "tool" && part.callID === ctx.callID,
      )
      // The running tool part predates permission and queue waits and survives recovery.
      const started = Math.min(
        reserved.createdAt,
        part?.type === "tool" && part.state.status !== "pending" ? part.state.time.start : entered,
      )
      const pinned = await SubagentBudget.read(reserved.childSessionID)
      const contract =
        pinned &&
        (pinned.worker.stopReason ||
          pinned.worker.reportReason === "budget_wrapup" ||
          pinned.worker.reportReason === "deadline_wrapup" ||
          pinned.worker.assignmentID === identity.callID)
          ? pinned.worker
          : undefined
      const model =
        contract?.model ??
        (settings.workerModelOverride && settings.workerModel
          ? settings.workerModel
          : userLimits.model
            ? Provider.parseModel(userLimits.model)
            : leadModel)
      const variant = contract
        ? (contract.variant ??
          (await Session.messages({ sessionID: reserved.childSessionID }))
            .map((message) => message.info)
            .findLast((message): message is MessageV2.User => message.role === "user")?.variant)
        : model.providerID === leadModel.providerID && model.modelID === leadModel.modelID
          ? typeof ctx.extra?.variant === "string"
            ? ctx.extra.variant
            : undefined
          : agent.variant

      const existing =
        continuation ??
        (await Session.get(reserved.childSessionID).catch((error) => {
          if (Storage.NotFoundError.isInstance(error)) return
          throw error
        }))
      const parentRules = await Session.get(ctx.sessionID)
        .then((parent) => parent.permission ?? [])
        .catch(() => [])
      const session = existing
        ? assertTaskContinuation({ session: existing, parentSessionID: ctx.sessionID, projectID: Instance.project.id })
        : await Session.createNext({
            id: reserved.childSessionID,
            parentID: ctx.sessionID,
            directory: Instance.directory,
            title: params.description,
            permission: childPermissionRules(agent, config.experimental?.primary_tools, parentRules),
          })
      if (existing)
        await Session.update(
          session.id,
          (info) => {
            info.permission = childPermissionRules(agent, config.experimental?.primary_tools, parentRules)
          },
          { touch: false },
        )
      // The child keeps its own scratch for staged inputs and side outputs but
      // works in the parent's directory: the files it writes there are the
      // parent's deliverables.
      await SessionFilesystem.shareWorkingDirectory({ parentSessionID: ctx.sessionID, childSessionID: session.id })
      // And the parent reads the child's scratch, so the files a worker's
      // report names can be opened from the lead's transcript.
      await SessionFilesystem.shareWorkerScratch({ parentSessionID: ctx.sessionID, childSessionID: session.id })

      const metadata = {
        sessionId: session.id,
        model,
        startedAt: started,
        effort,
        delegation: settings,
        ...(params.background ? { background: true } : {}),
      }
      await ctx.metadata({ title: params.description, metadata })

      const increaseLabel = (unit: SubagentBudget.Unit) =>
        unit === "usd"
          ? formatUsd(userLimits.usdIncrease)
          : `${userLimits.tokenIncrease.toLocaleString("en-US")} tokens`
      /** One question to the user at a limit stop, withdrawn after `TaskLimit.ASK_TIMEOUT_MS`. */
      const askAtLimit = async (input: {
        limitReason: string
        unit: SubagentBudget.Unit
        live: boolean
        signal: AbortSignal
      }): Promise<TaskLimit.Choice> => {
        const deadline = input.limitReason === "deadline"
        const more = deadline ? "Allow more time" : `Add ${increaseLabel(input.unit)}`
        const finish = "Finish without it"
        const minutes = TaskLimit.ASK_TIMEOUT_MS / 60_000
        const answers = await Question.ask(
          {
            sessionID: ctx.sessionID,
            questions: [
              {
                header: deadline ? "Subagent out of time" : "Subagent limit reached",
                question: `The worker "${params.description}" ${deadline ? "ran out of time" : "reached its limit"} before finishing. ${deadline ? "Let it continue with a new deadline?" : "Add to the subagent budget so it can continue?"} If no one answers within ${minutes} minutes, the main agent finishes from the worker's saved result.`,
                options: [
                  {
                    label: more,
                    description: deadline
                      ? "The main agent may continue this worker with a new deadline."
                      : "Raises the conversation's subagent budget; the main agent decides whether to continue this worker.",
                  },
                  { label: finish, description: "The main agent builds on the worker's saved result." },
                ],
                custom: false,
              },
            ],
            tool: input.live && ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            timeoutMs: TaskLimit.ASK_TIMEOUT_MS,
          },
          input.signal,
        ).catch((error: unknown) =>
          error instanceof Question.TimeoutError ? ("timeout" as const) : ("dismissed" as const),
        )
        if (typeof answers === "string") return answers
        const picked = answers[0]?.[0]
        return picked === more ? "more" : picked === finish ? "finish" : "dismissed"
      }
      const run = async (signal: AbortSignal, live: boolean): Promise<TaskAttempt.Result> => {
        await using attemptLease = await TaskAttempt.acquire(identity, Number.POSITIVE_INFINITY, signal)
        return await attemptLease.during(async () => {
          const current = await TaskAttempt.read(identity)
          if (!current) throw new Error(`Durable Task attempt ${ctx.callID} disappeared after reservation`)
          if (current.status === "completed" && current.result) return current.result
          PayloadIntegrity.assert({ content: attemptInput.prompt, before: "", messages: ctx.messages })

          const initial = await Session.messages({ sessionID: session.id })
          const bound = await TaskAttempt.bind({
            ...identity,
            previousMessageIDs: initial.map((message) => message.info.id),
          })
          const previous = new Set(bound.previousMessageIDs)
          const turn = initial.filter((message) => !previous.has(message.info.id))
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

          if (terminal) {
            await using recovery = await FileLease.acquire(
              SessionPrompt.loopLeasePath(Instance.project.id, session.id),
              10000,
              signal,
            )
            SessionPrompt.assertNotBusy(session.id)
            await SubagentBudget.release(session.id, identity.callID)
          }

          // A prior process may have died mid-turn; close its interval at its
          // last heartbeat before this process opens its own. Time between
          // reservation and activation is queueing, not child work.
          const settled = await TaskAttempt.settle(identity, terminal?.info.time.completed)
          const timing = { queuedMs: 0, activeMs: settled.activeMs ?? 0 }
          const execution = terminal
            ? { result: terminal, error: undefined }
            : await (async () => {
                const token = crypto.randomUUID()
                timing.queuedMs = Math.max(0, Date.now() - started)
                await TaskAttempt.activate({ ...identity, token })
                const activatedAt = Date.now()
                // `activeMs` present tells the UI the worker left the queue.
                if (live) {
                  await ctx.metadata({
                    title: params.description,
                    metadata: { ...metadata, queuedMs: timing.queuedMs, activeMs: timing.activeMs },
                  })
                }
                const exists = initial.some(
                  (message) => message.info.role === "user" && message.info.id === reserved.childMessageID,
                )
                const dispatch = async (childSignal: AbortSignal) => {
                  if (exists) return SessionPrompt.loop(session.id)
                  return SessionPrompt.prompt({
                    messageID: reserved.childMessageID,
                    sessionID: session.id,
                    model,
                    variant,
                    agent: agent.name,
                    effort,
                    delegationSettings: settings,
                    parts: [
                      ...(await SessionPrompt.resolvePromptParts(
                        `${params.prompt}\n\nExpected output: ${params.expected_output ?? "Return findings, artifact references, checks performed, remaining work and limitations."} Start the final report with Outcome: Complete or Outcome: Incomplete.`,
                      )),
                      ...(await SubtaskAttachments.materialize(attachments, session.id, childSignal)),
                    ],
                  })
                }
                const pulse = setInterval(() => {
                  void TaskAttempt.pulse({ ...identity, token }).catch(() => undefined)
                }, 5_000)
                // While the child runs, its tool progress is mirrored into this
                // call's metadata so the parent's UI and the runtime API can show
                // what the worker is doing and cancel it knowingly.
                const observed: Record<
                  string,
                  { id: string; tool: string; state: { status: string; title?: string } }
                > = {}
                const unsubscribe = live
                  ? Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
                      const part = evt.properties.part
                      if (part.sessionID !== session.id || part.type !== "tool") return
                      if (part.messageID === reserved.childMessageID) return
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
                          ...metadata,
                          summary: Object.values(observed).sort((a, b) => a.id.localeCompare(b.id)),
                          elapsedMs: Date.now() - started,
                          queuedMs: timing.queuedMs,
                          activeMs: timing.activeMs + Math.max(0, Date.now() - activatedAt),
                        },
                      })
                    })
                  : undefined
                try {
                  // Keep progress and cancellation connected until the child settles.
                  const root = await rootSession(ctx.sessionID)
                  const bounded = await SubagentBudget.initialize(root, userLimits)
                  if (!bounded)
                    return await SessionPrompt.withCancellation(session.id, () => dispatch(signal), signal).then(
                      (result) => ({ result, error: undefined }),
                      (error: unknown) => ({ result: undefined, error }),
                    )
                  const route = await resolveAccessRoute(model.providerID, model.modelID)
                  const unit = SubagentDispatch.unit(await Provider.getModel(model.providerID, model.modelID), route)
                  const stored = await SubagentBudget.read(session.id)
                  const contract = await SubagentBudget.open({
                    rootSessionID: root,
                    parentSessionID: ctx.sessionID,
                    sessionID: session.id,
                    assignmentID: identity.callID,
                    objective: params.prompt,
                    description: params.description,
                    agent: agent.name,
                    expectedOutput: params.expected_output ?? "Return findings, artifacts, checks and limitations.",
                    model,
                    variant,
                    route,
                    unit,
                    settings: userLimits,
                    allocation:
                      unit === "usd"
                        ? params.allocation?.usd === undefined
                          ? undefined
                          : SubagentBudget.dollars(params.allocation.usd)
                        : params.allocation?.tokens,
                    acceptedAt: started,
                    deadline:
                      stored?.worker.assignmentID === identity.callID
                        ? stored.worker.deadline
                        : started + (userLimits.deadlineMs ?? 600000),
                  })
                  await using allowance = await SubagentBudget.watch(contract, signal)
                  return await SessionPrompt.withCancellation(
                    session.id,
                    () => dispatch(allowance.signal),
                    allowance.signal,
                  ).then(
                    (result) => ({ result, error: undefined }),
                    (error: unknown) => ({ result: undefined, error }),
                  )
                } catch (error) {
                  return { result: undefined, error }
                } finally {
                  clearInterval(pulse)
                  unsubscribe?.()
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
          const budgetState = await SubagentBudget.read(session.id)
          const budget = budgetState?.worker.assignmentID === identity.callID ? budgetState : undefined
          const observed = classifyTaskOutcome({
            finish: child?.finish,
            error: execution.error ?? child?.error,
            hasText: text.trim().length > 0,
            toolCalls: summary.length,
            failedToolCalls,
            partialToolCalls,
          })
          const reportedIncomplete = /^\s*(?:\*\*)?Outcome:\s*(?:\*\*)?\s*Incomplete\b/im.test(text)
          const limitReason =
            budget?.worker.stopReason ??
            (execution.error instanceof SubagentBudget.LimitError ? execution.error.reason : undefined)
          const taskOutcome: TaskOutcome = limitReason
            ? { outcome: "partial", stopReason: limitReason }
            : reportedIncomplete
              ? {
                  outcome: "partial",
                  stopReason: budget?.worker.wrapup
                    ? (budget.worker.wrapupReason ?? "budget_wrapup")
                    : "reported_incomplete",
                }
              : observed
          const state: TaskState = taskOutcome.outcome === "error" ? "error" : "completed"
          // The pool to extend: the worker's own record, or, when the pool was already
          // exhausted at admission and no record exists for this call, the conversation's.
          const target = budget
            ? { root: budget.pool.rootSessionID, unit: budget.worker.unit }
            : limitReason === "budget_limit" || limitReason === "token_limit"
              ? {
                  root: await rootSession(ctx.sessionID),
                  unit: limitReason === "budget_limit" ? ("usd" as const) : ("tokens" as const),
                }
              : undefined
          const increase = (unit: SubagentBudget.Unit) =>
            unit === "usd" ? SubagentBudget.dollars(userLimits.usdIncrease) : userLimits.tokenIncrease
          const headroom = target ? await SubagentBudget.headroom(target.root, target.unit, ctx.sessionID) : 0
          const next = limitReason
            ? await TaskLimit.resolve({
                reason: limitReason,
                autonomy: settings.autonomy,
                attended: target !== undefined && (await answerable(ctx.sessionID)),
                remaining:
                  target && headroom >= increase(target.unit)
                    ? target.unit === "usd"
                      ? formatUsd(SubagentBudget.usd(headroom))
                      : `${headroom.toLocaleString("en-US")} tokens`
                    : undefined,
                ask: () => askAtLimit({ limitReason, unit: target!.unit, live, signal }),
                raise: async () => {
                  const current = await SubagentBudget.inspect(target!.root)
                  if (!current) throw new Error("Subagent allowance not found")
                  await SubagentBudget.increase(target!.root, {
                    unit: target!.unit,
                    amount: increase(target!.unit),
                    revision: current.revision,
                    key: `limit:${identity.callID}`,
                  })
                  return increaseLabel(target!.unit)
                },
              })
            : undefined
          const note = limitReason
            ? `Runtime: subagent incomplete — ${limitReason.replaceAll("_", " ")}. ${execution.error instanceof SubagentBudget.LimitError ? execution.error.message : "Saved partial results follow."} ${next}`
            : taskOutcome.stopReason === "max_steps"
              ? "The subagent reached its step limit; partial result follows."
              : taskOutcome.stopReason === "tool_failures"
                ? "Every subagent tool call failed; treat this as a blocked partial result."
                : taskOutcome.stopReason === "tool_partial"
                  ? "One or more subagent operations remain partial or unsettled; treat this as a partial result."
                  : taskOutcome.stopReason === "provider_error"
                    ? "The subagent stopped on a provider error; its partial result follows. Finish this step yourself rather than re-sending the same brief."
                    : taskOutcome.stopReason === "cancelled"
                      ? "The subagent was cancelled; completed actions and partial evidence follow."
                      : taskOutcome.stopReason === "empty_handoff"
                        ? "The subagent ended without a textual handoff; treat this result as incomplete."
                        : failedToolCalls > 0
                          ? `${failedToolCalls} of ${summary.length} tool calls failed along the way; the report is the worker's own account.`
                          : undefined
          const accounting = budget
            ? (() => {
                const w = budget.worker
                const details = SubagentBudget.summary(budget.pool, w)
                const format = (value: number) =>
                  w.unit === "usd" ? `USD ${SubagentBudget.usd(value)}` : `${value} tokens`
                return `Runtime accounting: model=${w.model.providerID}/${w.model.modelID}; route=${w.route}; grant=${format(w.limit)}; ${format(w.spent)} used; ${format(details.remaining)} assignment remaining; ${format(details.pending)} pending; ${format(SubagentBudget.available(budget.pool, w.unit))} shared pool available. ${w.unit === "usd" ? "Calculated allowance use, not a settled Wallet charge." : "Provider token use, not account quota."}`
              })()
            : undefined
          const body = [
            SubagentResult.describe(taskOutcome.outcome, taskOutcome.stopReason),
            accounting,
            text || `(no text; ${summary.length} tool calls in this turn)`,
            TaskEvidence.describe(evidence),
            `task_id: ${session.id}`,
          ]
            .filter(Boolean)
            .join("\n\n")
          const result = TaskAttempt.Result.parse({
            title: params.description,
            metadata: {
              ...metadata,
              summary,
              durationMs: Date.now() - started,
              queuedMs: timing.queuedMs,
              activeMs: timing.activeMs,
              toolCalls: summary.length,
              failedToolCalls,
              partialToolCalls,
              usage,
              ...(accounting ? { accounting } : {}),
              ...(budget ? { budget: SubagentBudget.summary(budget.pool, budget.worker) } : {}),
              outcome: taskOutcome.outcome,
              stopReason: taskOutcome.stopReason,
              handoff: text,
              evidence,
              commandReceipts: TaskEvidence.describeCommands(evidence.commands),
            },
            output: renderTaskOutput({ sessionID: session.id, state, summary: note, text: body }),
          })
          if (budget)
            await SubagentBudget.report(session.id, {
              handoff: text,
              outcome: taskOutcome.outcome,
              reason: taskOutcome.stopReason,
            })
          await TaskAttempt.complete({ ...identity, result })
          return result
        })
      }

      if (!params.background) return run(ctx.abort, true)

      // Background: the child runs detached from this call and from the
      // parent's turn (whose abort fires when the turn ends); its completion
      // wakes the parent with a synthetic message carrying the same envelope.
      const parentAgent = ctx.agent
      const wake = (output: string) =>
        SessionWake.deliver({
          sessionID: ctx.sessionID,
          agent: parentAgent,
          model: leadModel,
          variant: typeof ctx.extra?.variant === "string" ? ctx.extra.variant : undefined,
          text: output,
          describe: `background task ${session.id}`,
        })
      // The dispatching call settled long ago with `background: true`; once the
      // worker finishes, the recorded call takes the worker's real outcome and
      // duration so the transcript shows the work, not the dispatch. The output
      // the model already read stays as it was: it is part of the cached prefix.
      const settle = async (result: TaskAttempt.Result) => {
        const parts = await MessageV2.parts(ctx.messageID)
        const part = parts.find((item) => item.type === "tool" && item.callID === ctx.callID)
        if (!part || part.type !== "tool" || part.state.status !== "completed") return
        await Session.updatePart({
          ...part,
          state: { ...part.state, metadata: { ...result.metadata, background: true, jobId: session.id } },
        })
      }
      if (!background.has(session.id)) {
        // Detached from the dispatching turn's admission context: the child
        // and the wake-up run after that turn has finished. A failure becomes
        // an error result so a caller waiting on the entry always gets one.
        const controller = new AbortController()
        const outcome = SessionPrompt.detached(() => run(controller.signal, false)).catch((error: unknown) => {
          const observed =
            error instanceof SubagentBudget.LimitError
              ? { outcome: "partial" as const, stopReason: error.reason }
              : classifyTaskOutcome({ error })
          return TaskAttempt.Result.parse({
            title: params.description,
            metadata: {
              ...metadata,
              ...observed,
            },
            output: renderTaskOutput({
              sessionID: session.id,
              state: "error",
              summary: `Background task failed: ${params.description}`,
              text: [
                SubagentResult.describe(observed.outcome, observed.stopReason),
                error instanceof Error ? error.message : String(error),
              ].join("\n\n"),
            }),
          })
        })
        const entry: Background = {
          parentID: ctx.sessionID,
          controller,
          result: outcome,
          delivered: false,
          parentStopped: false,
        }
        background.set(session.id, entry)
        outcome.then(async (result) => {
          background.delete(session.id)
          await settle(result).catch((error) => log.warn("background task outcome was not recorded", { error }))
          // A call that joined the worker has already taken the report.
          if (entry.delivered) return
          if (entry.parentStopped) return
          await SessionPrompt.detached(() => wake(result.output)).catch((error) =>
            log.error("background task completion could not wake the parent", { error }),
          )
        })
      }
      return {
        title: params.description,
        metadata: { ...metadata, background: true, jobId: session.id },
        output: renderTaskOutput({
          sessionID: session.id,
          state: "running",
          summary: `Background task started: ${params.description}`,
          text: BACKGROUND_STARTED,
        }),
      }
    },
  }
})
