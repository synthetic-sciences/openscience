import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionTelemetry } from "./telemetry"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { accessRoute, resolveCredentialSource } from "./access-route"
import { requiresWalletBalance } from "./access-route"
import type { CredentialSource } from "./access-route"
import { OpenScience } from "@/openscience"
import { SessionTraceStore } from "./trace-store"
import type { NamedError } from "@synsci/util/error"
import { ToolRetryGuard } from "./tool-retry-guard"
import { SessionResearch } from "./research"
import { SearchDedupe } from "./search-dedupe"
import { SessionLoopState } from "./loop-state"
import { InvalidCall } from "@/tool/invalid-call"
import { ToolSelection } from "./tool-selection"
import { ProjectAccess } from "@/project/access"
import { Instance } from "@/project/instance"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  // Hard ceiling on transient-error retries within a single message generation.
  // The retry loop is otherwise unbounded, and retry.ts classifies any JSON
  // body carrying an `error` field as retryable — so a persistently-failing
  // provider (or a permanent error arriving as JSON) looped forever.
  const MAX_RETRY_ATTEMPTS = 10
  const log = Log.create({ service: "session.processor" })

  export function managedPauseError(message: string) {
    return new MessageV2.APIError({
      message,
      statusCode: 503,
      isRetryable: true,
      metadata: { openscience_state: "paused", action: "retry" },
    })
  }

  export async function fundingSnapshot(source: CredentialSource) {
    if (!requiresWalletBalance(source)) return
    return (await OpenScience.getReconciledFundingState())?.snapshot
  }

  /** True when the last `threshold` TOOL calls are the same tool with the same
   *  input, ignoring reasoning/text/step parts interleaved between them. A naive
   *  "last N raw parts" check was defeated by reasoning models, which emit a
   *  reasoning part before each tool call, so the doom-loop guard never fired. */
  export function isDoomLoop(
    parts: MessageV2.Part[],
    toolName: string,
    input: unknown,
    threshold = DOOM_LOOP_THRESHOLD,
  ): boolean {
    const tools = parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
    const last = tools.slice(-threshold)
    if (last.length < threshold) return false
    return last.every(
      (p) =>
        p.tool === toolName && p.state.status !== "pending" && JSON.stringify(p.state.input) === JSON.stringify(input),
    )
  }

  export function isMalformedLoop(parts: MessageV2.Part[], input: unknown, threshold = 2) {
    const calls = parts.filter(
      (part): part is MessageV2.ToolPart =>
        part.type === "tool" && part.tool === "invalid" && part.state.status !== "pending",
    )
    const last = calls.slice(-threshold)
    if (last.length < threshold) return false
    const signature = InvalidCall.signature(input)
    return last.every((part) => InvalidCall.signature(part.state.input) === signature)
  }

  function toolErrorSignature(error: string) {
    return error
      .toLowerCase()
      .replace(/\b(?:artifact-path|artifact|tool-call|tool):[^\s,;]+/g, "$ref")
      .replace(/\b(?:ses|msg|prt|call|job|lesson)[_-][a-z0-9_-]+\b/g, "$id")
      .replace(/\b\d+(?:\.\d+)?\b/g, "#")
      .replace(/\s+/g, " ")
      .trim()
  }

  export function isToolErrorLoop(parts: MessageV2.Part[], toolName: string, threshold = 2) {
    const calls = parts.filter(
      (part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateError } =>
        part.type === "tool" && part.tool === toolName && part.state.status === "error",
    )
    const last = calls.slice(-threshold)
    if (last.length < threshold) return false
    const signature = toolErrorSignature(last.at(-1)!.state.error)
    return last.every((part) => toolErrorSignature(part.state.error) === signature)
  }

  /** Collect all assistant parts produced for one user request. The prompt loop
   * creates a new assistant message after every tool step, so checking only the
   * current message misses the most common repeated-call failure mode. */
  export function turnParts(messages: MessageV2.WithParts[], parentID: string): MessageV2.Part[] {
    const users = new Map(
      messages
        .filter((message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user")
        .map((message) => [message.info.id, message] as const),
    )
    const parent = users.get(parentID)
    const epoch = parent
      ? (SessionLoopState.messageEpoch(parent.info) ?? (SessionLoopState.external(parent) ? parent.info.id : undefined))
      : undefined
    return messages
      .filter((message) => {
        if (message.info.role !== "assistant") return false
        if (!epoch) return message.info.parentID === parentID
        const owner = users.get(message.info.parentID)
        if (!owner) return false
        return SessionLoopState.messageEpoch(owner.info) === epoch || owner.info.id === epoch
      })
      .sort((left, right) => left.info.id.localeCompare(right.info.id))
      .flatMap((message) => message.parts)
  }

  function sharedPrefixLen(a: string, b: string): number {
    const n = Math.min(a.length, b.length)
    let i = 0
    while (i < n && a[i] === b[i]) i++
    return i
  }

  /** True when the last 3 finished assistant turns are long AND share a large
   *  identical leading block — the repeated "continuity summary" a weak/local
   *  model emits instead of converging on a final answer (#176). The tool-call
   *  isDoomLoop guard can't see this: the TEXT repeats, not the tool calls. Inputs
   *  are already-normalized turn texts (lowercased, whitespace-collapsed). Kept
   *  conservative — 3 substantial near-identical turns in a row is a signal that
   *  legitimate progress does not produce. */
  export function isTextLoop(turns: string[], minLen = 400, prefix = 300): boolean {
    if (turns.length < 3) return false
    const last = turns.slice(-3)
    const lengths = last.map((t) => t.length)
    if (Math.min(...lengths) < minLen) return false
    if (Math.max(...lengths) / Math.max(1, Math.min(...lengths)) > 1.25) return false
    return sharedPrefixLen(last[0], last[1]) >= prefix && sharedPrefixLen(last[1], last[2]) >= prefix
  }

  /** An explicitly configured provider inactivity deadline is already bounded
   * and actionable. Retrying it repeatedly at the same deadline would turn one
   * failure into a long cascade. */
  export function retryableProviderError(error: unknown, normalized: ReturnType<NamedError["toObject"]>) {
    return Provider.isIdleTimeoutError(error) ? undefined : SessionRetry.retryable(normalized)
  }

  export function providerFailureAction(
    error: unknown,
    normalized: ReturnType<NamedError["toObject"]>,
    toolStarted: boolean,
  ) {
    if (Provider.isIdleTimeoutError(error)) {
      const message = error instanceof Error ? error.message : "Provider request became idle"
      if (toolStarted) return { type: "drain" as const, message }
      return { type: "retry-idle" as const, message }
    }
    // The gateway sealed this attempt before any output reached the client;
    // the next attempt number yields a fresh idempotency key, so one
    // re-dispatch is safe. It is never part of the transient retry budget.
    const redispatch = SessionRetry.redispatchable(normalized)
    if (redispatch !== undefined) {
      if (toolStarted) return { type: "drain" as const, message: redispatch }
      return { type: "redispatch" as const, message: redispatch }
    }
    const message = retryableProviderError(error, normalized)
    if (message === undefined) return { type: "terminal" as const }
    if (toolStarted) return { type: "drain" as const, message }
    return { type: "retry" as const, message }
  }

  export type ProviderRetryState = {
    attempt: number
    transientRetries: number
    idleRetryUsed: boolean
    redispatchUsed: boolean
  }

  /** Keep the one safe idle replay and the one managed re-dispatch independent
   * from ordinary transport retries. A preceding ECONNRESET must not silently
   * consume the only replay available for a later, side-effect-free idle
   * expiry, and a sealed gateway attempt is re-dispatched exactly once. */
  export function consumeProviderRetry(
    type: "retry" | "retry-idle" | "redispatch",
    state: ProviderRetryState,
  ): ProviderRetryState | undefined {
    if (type === "redispatch") {
      if (state.redispatchUsed) return
      return { ...state, attempt: state.attempt + 1, redispatchUsed: true }
    }
    if (type === "retry-idle") {
      if (state.idleRetryUsed) return
      return { ...state, attempt: state.attempt + 1, idleRetryUsed: true }
    }
    if (type === "retry") {
      if (state.transientRetries >= MAX_RETRY_ATTEMPTS) return
      return { ...state, attempt: state.attempt + 1, transientRetries: state.transientRetries + 1 }
    }
  }

  /** File snapshots protect tool side effects. A model that cannot call any
   * advertised tool cannot mutate the workspace, so two Git index passes add
   * latency and contention without creating a useful revert boundary. */
  export function tracks(input: { tools: Record<string, unknown>; toolcall: boolean }) {
    return input.toolcall && Object.keys(input.tools).length > 0
  }

  /** Close a streamed part without replacing its first-output timestamp. */
  export function finishTime(time: { start: number; end?: number } | undefined, end = Date.now()) {
    return {
      start: time?.start ?? end,
      end,
    }
  }

  /** A provider policy finish is terminal, but tool side effects are not a
   * textual handoff. Preserve the finish reason while giving every client a
   * retryable error whenever the provider filters the final answer, including
   * turns where one or more tools already ran. */
  export function emptyContentFilterError(finish: string | undefined, parts: MessageV2.Part[]) {
    if (finish !== "content-filter") return
    const hasText = parts.some((part) => part.type === "text" && !part.ignored && part.text.trim().length > 0)
    if (hasText) return
    return new MessageV2.APIError({
      message:
        "The provider blocked this response with its content filter and returned no content or textual handoff. Retry the request or choose another model.",
      isRetryable: true,
      metadata: {
        action: "retry",
        provider_finish_reason: "content-filter",
      },
    })
  }

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  type ToolExecutionOutput = {
    title: string
    output: string
    metadata?: Record<string, unknown>
    attachments?: MessageV2.FilePart[]
  }

  type ToolMetadataUpdate = {
    title?: string
    metadata?: Record<string, unknown>
  }

  export class ToolCallConflictError extends Error {
    constructor() {
      super("Provider reused a tool call ID with different input. No duplicate action was taken.")
      this.name = "ToolCallConflictError"
    }
  }

  /**
   * Correlate the AI SDK's stream events with the actual execute promise.
   *
   * A provider may omit `tool-result`, and a fast execute promise may settle
   * before its `tool-call` stream event is observed. Keeping these two channels
   * in one small coordinator makes either ordering durable and lets the
   * processor drain work that has started before it finalizes the turn.
   */
  export function createToolOutcomeCoordinator(input: {
    abort: AbortSignal
    updatePart: (part: MessageV2.ToolPart) => Promise<unknown>
    onRejected?: (error: unknown) => void
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    const outcomes = new Map<
      string,
      | { status: "completed"; input: unknown; output: ToolExecutionOutput; startedAt?: number; endedAt: number }
      | { status: "error"; input: unknown; error: unknown; startedAt?: number; endedAt: number }
    >()
    const active = new Map<string, Promise<void>>()
    const executions = new Map<string, { signature: string; promise: Promise<ToolExecutionOutput> }>()
    const metadataWrites = new Map<string, Promise<void>>()
    const terminalParts = new Map<string, MessageV2.ToolPart>()
    const names = new Map<string, string>()
    const applying = new Set<string>()
    const settled = new Set<string>()

    async function apply(callID: string) {
      const outcome = outcomes.get(callID)
      if (!outcome || settled.has(callID) || applying.has(callID)) {
        return false
      }
      const initial = toolcalls[callID]
      if (!initial || initial.state.status !== "running") return false
      applying.add(callID)
      try {
        // Tool.Context.metadata() is intentionally fire-and-forget for tool
        // authors. Serialize those writes before the terminal result so a slow
        // progress update can never restore an already-completed part to
        // `running` after execute() returns.
        await metadataWrites.get(callID)
        const match = toolcalls[callID]
        if (!match || match.state.status !== "running" || settled.has(callID)) return false
        const startedAt = outcome.startedAt ?? Math.min(match.state.time.start, outcome.endedAt)
        const time = { start: startedAt, end: Math.max(startedAt, outcome.endedAt) }
        let terminal: MessageV2.ToolPart
        if (outcome.status === "completed") {
          terminal = {
            ...match,
            state: {
              status: "completed",
              input: outcome.input ?? match.state.input,
              ...(match.state.raw ? { raw: match.state.raw } : {}),
              output: outcome.output.output,
              metadata: outcome.output.metadata ?? {},
              title: outcome.output.title,
              time,
              attachments: outcome.output.attachments,
            },
          }
        } else {
          const metadata = ToolRetryGuard.errorMetadata(outcome.error)
          terminal = {
            ...match,
            state: {
              status: "error",
              input: outcome.input ?? match.state.input,
              ...(match.state.raw ? { raw: match.state.raw } : {}),
              error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
              ...(metadata ? { metadata } : {}),
              time,
            },
          }
        }
        await input.updatePart(terminal)
        terminalParts.set(callID, terminal)
        if (outcome.status === "error") {
          input.onRejected?.(outcome.error)
        }
        settled.add(callID)
        delete toolcalls[callID]
        outcomes.delete(callID)
        return true
      } finally {
        applying.delete(callID)
      }
    }

    async function complete(callID: string, args: unknown, output: ToolExecutionOutput, startedAt?: number) {
      if (settled.has(callID)) return
      outcomes.set(callID, { status: "completed", input: args, output, startedAt, endedAt: Date.now() })
      await apply(callID)
    }

    async function fail(callID: string, args: unknown, error: unknown, startedAt?: number) {
      if (settled.has(callID)) return
      outcomes.set(callID, { status: "error", input: args, error, startedAt, endedAt: Date.now() })
      await apply(callID)
    }

    const coordinator = {
      part(callID: string) {
        return toolcalls[callID]
      },
      claim(callID: string, name: string) {
        const canonical = InvalidCall.tool(name)
        const existing = names.get(callID)
        if (existing && existing !== canonical) throw new ToolCallConflictError()
        names.set(callID, canonical)
      },
      closed(callID: string) {
        return settled.has(callID)
      },
      pending(part: MessageV2.ToolPart) {
        toolcalls[part.callID] = part
      },
      async delta(callID: string, delta: string) {
        const match = toolcalls[callID]
        if (!match || match.state.status !== "pending") return
        const updated: MessageV2.ToolPart = {
          ...match,
          state: {
            ...match.state,
            raw: match.state.raw + delta,
          },
        }
        toolcalls[callID] = updated
        // Keep streamed arguments in memory until the provider closes or
        // materializes the call. Persisting the full, ever-growing `raw` value
        // for every tiny delta creates quadratic disk/event traffic (a 95 KB
        // malformed call previously generated ~75 MB of duplicate events and
        // starved the local server). Pending input is not actionable in the UI;
        // one durable write at the boundary preserves the complete audit bytes.
      },
      async flush(callID: string) {
        const match = toolcalls[callID]
        if (!match || match.state.status !== "pending") return
        await input.updatePart(match)
      },
      async running(part: MessageV2.ToolPart) {
        toolcalls[part.callID] = part
        await apply(part.callID)
      },
      metadata(callID: string, args: unknown, value: ToolMetadataUpdate) {
        const previous = metadataWrites.get(callID) ?? Promise.resolve()
        const write = previous
          .catch(() => undefined)
          .then(async () => {
            if (settled.has(callID)) return
            const match = toolcalls[callID]
            if (!match || match.state.status !== "running") return
            const updated: MessageV2.ToolPart = {
              ...match,
              state: {
                ...match.state,
                title: value.title,
                metadata: value.metadata ?? {},
                input: (args ?? match.state.input) as Record<string, any>,
                time: {
                  start: match.state.time.start,
                },
              },
            }
            toolcalls[callID] = updated
            await input.updatePart(updated)
          })
          .catch((error) => {
            input.onRejected?.(error)
          })
        metadataWrites.set(callID, write)
        void write.finally(() => {
          if (metadataWrites.get(callID) === write && settled.has(callID)) metadataWrites.delete(callID)
        })
      },
      async result(callID: string, args: unknown, output: ToolExecutionOutput, startedAt?: number) {
        if (executions.has(callID)) return
        await complete(callID, args, output, startedAt)
      },
      async error(callID: string, args: unknown, error: unknown, startedAt?: number) {
        if (executions.has(callID)) return
        await fail(callID, args, error, startedAt)
      },
      execute<T extends ToolExecutionOutput>(callID: string, args: unknown, run: () => Promise<T>) {
        const signature = SearchDedupe.signature(args)
        const existing = executions.get(callID)
        if (existing) {
          if (existing.signature !== signature) throw new ToolCallConflictError()
          return existing.promise as Promise<T>
        }
        const startedAt = Date.now()
        const execution = Promise.resolve()
          .then(run)
          .then(
            async (output) => {
              await complete(callID, args, output, startedAt)
              return output
            },
            async (error) => {
              await fail(callID, args, error, startedAt)
              throw error
            },
          )
        executions.set(callID, { signature, promise: execution })
        const drained = execution.then(
          () => undefined,
          () => undefined,
        )
        active.set(callID, drained)
        void drained.finally(() => {
          if (active.get(callID) === drained) active.delete(callID)
        })
        return execution
      },
      started() {
        return executions.size > 0
      },
      async drain() {
        const pending = [...active.values()]
        if (!pending.length || input.abort.aborted) return
        const aborted = Promise.withResolvers<void>()
        const onAbort = () => aborted.resolve()
        input.abort.addEventListener("abort", onAbort, { once: true })
        try {
          await Promise.race([Promise.all(pending), aborted.promise])
        } finally {
          input.abort.removeEventListener("abort", onAbort)
        }
      },
      async reconcile(part: MessageV2.ToolPart) {
        const terminal = terminalParts.get(part.callID)
        if (terminal) {
          await input.updatePart(terminal)
          return true
        }
        return apply(part.callID)
      },
      abandon(callID: string) {
        settled.add(callID)
        delete toolcalls[callID]
        outcomes.delete(callID)
      },
    }
    return coordinator
  }

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
    // Status published while this processor is streaming. Compaction turns pass
    // "compacting" so the UI can show a distinct loader.
    busyStatus?: "busy" | "compacting"
  }) {
    let snapshot: string | undefined
    let blocked = false
    let shouldBreakOnDeny = true
    let attempt = 0
    let transientRetries = 0
    let idleRetryUsed = false
    let redispatchUsed = false
    let needsCompaction = false
    let overflow = false

    const toolOutcomes = createToolOutcomeCoordinator({
      abort: input.abort,
      updatePart: Session.updatePart,
      onRejected(error) {
        if (error instanceof InvalidCall.RepeatedError) {
          blocked = true
          return
        }
        if (error instanceof PermissionNext.RejectedError || error instanceof Question.RejectedError) {
          blocked = shouldBreakOnDeny
        }
      },
    })

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolOutcomes.part(toolCallID)
      },
      executeTool<T extends ToolExecutionOutput>(toolCallID: string, args: unknown, run: () => Promise<T>) {
        return toolOutcomes.execute(toolCallID, args, run)
      },
      async toolResult(toolCallID: string, args: unknown, output: ToolExecutionOutput) {
        await toolOutcomes.result(toolCallID, args, output)
      },
      async toolError(toolCallID: string, args: unknown, error: unknown) {
        await toolOutcomes.error(toolCallID, args, error)
      },
      toolMetadata(toolCallID: string, args: unknown, value: ToolMetadataUpdate) {
        toolOutcomes.metadata(toolCallID, args, value)
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        // Resolve the transport before touching Atlas. BYOK and subscription
        // turns must stay independent from an unrelated saved Ace session.
        const credentialSource = await resolveCredentialSource(input.model.providerID, input.model.id)
        // One immutable funding choice spans preflight and every retry/step in
        // this provider operation. A settings change applies to the next turn.
        const funding = await fundingSnapshot(credentialSource)
        const tracking = tracks({ tools: streamInput.tools, toolcall: input.model.capabilities.toolcall })
        needsCompaction = false
        overflow = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        shouldBreakOnDeny = shouldBreak
        let traceRoute = "custom"
        const progress = (phase: SessionTelemetry.RequestPhase) =>
          SessionTelemetry.recordProgress({
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            attempt: attempt + 1,
            agent: input.assistantMessage.agent,
            providerID: input.model.providerID,
            modelID: input.model.id,
            phase,
          })
        while (true) {
          try {
            traceRoute = accessRoute(credentialSource, input.model)

            if (requiresWalletBalance(credentialSource)) {
              if (!funding) {
                throw managedPauseError(
                  "Ace is paused because OpenScience could not snapshot the connected funding account. Sign in again or switch to a direct provider or local model.",
                )
              }
              const balance = await OpenScience.getBalance(funding)
              if (balance === null) {
                throw managedPauseError(
                  "Ace is paused because OpenScience could not verify the current balance. Retry when the connection returns or switch to a direct provider or local model.",
                )
              }
              if (balance <= 0) {
                OpenScience.invalidateBalance()
                throw new Error(
                  "Your Ace balance is empty. Add credits at app.syntheticsciences.ai/billing or switch model access to BYOK / Subscription.",
                )
              }
            }

            const requestContext = {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              attempt: attempt + 1,
              agent: streamInput.agent.name,
              modelID: input.model.id,
              ...(credentialSource === "managed" && funding ? { funding } : {}),
            }
            // The conversation-first Research agent does not create or require
            // legacy research contracts, so an old persisted contract must not
            // silently reintroduce bounded-run finalization or block a turn.
            // Keep the gate for specialist/legacy agents that still opt into
            // that contract explicitly.
            const runtime: SessionResearch.RuntimeDecision = ToolSelection.minimalResearchAgent(streamInput.agent.name)
              ? ({ decision: "allow" } as const)
              : await SessionResearch.runtimePreflight(input.sessionID)
            if (runtime.decision === "block") {
              throw new Error(SessionResearch.exhaustionMessage(runtime))
            }

            const finalizing = runtime.decision === "finalize"
            const finalTurn = runtime.decision === "finalize" && runtime.finalizationCall === 2
            const textOnly = runtime.textOnly === true || finalTurn
            const request = finalizing
              ? {
                  ...streamInput,
                  // The first reserved turn may save/checkpoint work. The last
                  // one is deliberately text-only so an agent cannot consume
                  // the entire reserve on another tool loop and strand the user
                  // without a usable partial result.
                  tools: textOnly ? {} : streamInput.tools,
                  system: [
                    ...streamInput.system,
                    runtime.textOnly
                      ? `Cumulative research-runtime usage jumped directly past its hard limit (${runtime.reason ?? "configured limit reached"}). This is the single emergency finalization response. No tools are available. Return the best verified result or explicit partial result now, with the exact checkpoint or continuation state.`
                      : finalTurn
                        ? `This is the last reserved finalization turn for the research runtime budget (${runtime.reason ?? "configured limit reached"}). No tools are available. Return the best verified result or explicit partial result now, with the exact checkpoint or continuation state.`
                        : `The research contract runtime budget is at its finalization boundary (${runtime.reason ?? "configured limit reached"}). Do not open new branches or launch optional work. Preserve machine outputs and return the best verified result or explicit partial result now.`,
                  ],
                }
              : streamInput
            progress("connecting")
            const stream = await Provider.withRequestContext(requestContext, () =>
              LLM.stream({
                ...request,
                route: traceRoute,
                trace: { messageID: input.assistantMessage.id, attempt: attempt + 1 },
                onResponse: () => progress("waiting_first_token"),
                onReasoningEffortResolved: async (effort) => {
                  if (input.assistantMessage.reasoningEffort === effort) return
                  input.assistantMessage.reasoningEffort = effort
                  await Session.updateMessage(input.assistantMessage)
                },
              }),
            )
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}

            for await (const value of Provider.withRequestContextIterable(requestContext, stream.fullStream)) {
              input.abort.throwIfAborted()
              // First content is the honest first-output timestamp. A role-only
              // delta or an SSE keepalive comment never reaches this branch, and
              // the record ignores the repeat on every later delta.
              if (
                ((value.type === "text-delta" || value.type === "reasoning-delta") && value.text.length > 0) ||
                value.type === "tool-input-start" ||
                value.type === "tool-call"
              ) {
                progress("streaming")
              }
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: input.busyStatus ?? "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    // A provider signature authenticates the exact thinking bytes.
                    // Trimming even one trailing byte makes the next turn invalid.
                    part.time = finishTime(part.time)
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  toolOutcomes.claim(value.id, value.toolName)
                  if (toolOutcomes.closed(value.id)) break
                  const part = await Session.updatePart({
                    id: toolOutcomes.part(value.id)?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolOutcomes.pending(part as MessageV2.ToolPart)
                  break

                case "tool-input-delta":
                  await toolOutcomes.delta(value.id, value.delta)
                  break

                case "tool-input-end":
                  await toolOutcomes.flush(value.id)
                  break

                case "tool-call": {
                  const match = toolOutcomes.part(value.toolCallId)
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        ...(match.state.status === "pending" && match.state.raw ? { raw: match.state.raw } : {}),
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    // Some providers omit the terminal tool-result event even
                    // though the execute promise has already settled. The
                    // execute wrapper records that authoritative outcome, so
                    // reconcile it as soon as the call part exists.
                    await toolOutcomes.running(part as MessageV2.ToolPart)

                    const history = await Array.fromAsync(MessageV2.stream(input.sessionID))
                    const parts = turnParts(history, input.assistantMessage.parentID)
                    const repeated =
                      value.toolName === "invalid"
                        ? isMalformedLoop(parts, value.input)
                        : isDoomLoop(parts, value.toolName, value.input)

                    if (repeated) {
                      if (value.toolName === "invalid") {
                        const source = InvalidCall.signature(value.input).split(":", 1)[0]
                        blocked = true
                        await Session.updatePart({
                          id: Identifier.ascending("part"),
                          messageID: input.assistantMessage.id,
                          sessionID: input.sessionID,
                          type: "text",
                          synthetic: true,
                          text: `OpenScience stopped two repeated incomplete ${source} calls before execution. No action was taken.`,
                          time: { start: Date.now(), end: Date.now() },
                        } satisfies MessageV2.TextPart)
                        break
                      }
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        mode: (await ProjectAccess.status(Instance.project)).mode,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  await result.toolResult(value.toolCallId, value.input, value.output)
                  break
                }

                case "tool-error": {
                  await result.toolError(value.toolCallId, value.input, value.error)
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = tracking ? await Snapshot.track() : undefined
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    tier: streamInput.user.tier,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  const stepPartID = Identifier.ascending("part")
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: stepPartID,
                    reason: value.finishReason,
                    snapshot: tracking ? await Snapshot.track() : undefined,
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  // Only compact MID-TASK — when the agent is still going (more tool calls).
                  // On a completed answer (finish "stop"/"length"/…) we must NOT compact here:
                  // that would auto-resume a finished request and make the agent invent
                  // unrequested work. Instead the turn just ends and yields; the NEXT user
                  // message trips the proactive start-of-turn check (claude-code's model).
                  // Also skip the summary turn itself: its input IS the over-threshold history
                  // being compacted, so it would always trip isOverflow.
                  if (
                    !input.assistantMessage.summary &&
                    MessageV2.isContinuing(value.finishReason) &&
                    (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                  ) {
                    needsCompaction = true
                  }
                  // A "length" finish with an over-threshold token count is NOT a
                  // finished answer — the turn was truncated mid-thought (often right
                  // before a tool call, leaving a pending tool part). isContinuing()
                  // excludes "length", so the block above skips it. Treat it as a
                  // context overflow: compact history and re-run the SAME user message
                  // against the summary. A genuine max-output truncation (small input)
                  // has isOverflow=false; the outer prompt loop recovers it with a
                  // bounded synthetic continuation so partial file writes are not
                  // mistaken for task completion.
                  if (
                    !input.assistantMessage.summary &&
                    value.finishReason === "length" &&
                    (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                  ) {
                    overflow = true
                    input.assistantMessage.finish = "compact"
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = finishTime(currentText.time)
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction || overflow) break
            }

            const filtered = emptyContentFilterError(
              input.assistantMessage.finish,
              await MessageV2.parts(input.assistantMessage.id),
            )
            if (filtered) {
              const error = MessageV2.fromError(filtered, { providerID: input.model.providerID })
              input.assistantMessage.error = error
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error,
              })
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            // A context-window overflow is deterministic — retrying the same
            // oversized input can only fail again. Signal the outer loop (via the
            // "overflow" return below) to compact + resume instead of burning
            // retries or surfacing an error. Checked BEFORE retryable() so it
            // isn't swallowed by the generic "Provider Server Error" bucket.
            overflow = SessionRetry.isContextOverflow(error)
            if (overflow) {
              log.info("context overflow — compacting instead of retrying", { sessionID: input.sessionID })
              // Mark the turn finished so it isn't persisted as a blank, statusless
              // assistant bubble; the outer loop compacts it away and resumes.
              input.assistantMessage.finish = "compact"
            }
            if (!overflow) {
              // A silent provider retrying ten times at the same idle deadline
              // recreates the original 50-minute failure. Idle expiry is a
              // terminal, actionable outcome; other transient failures retain
              // the existing retry policy.
              const action = providerFailureAction(e, error, toolOutcomes.started())
              if (action.type === "retry" || action.type === "retry-idle" || action.type === "redispatch") {
                const retry = consumeProviderRetry(action.type, {
                  attempt,
                  transientRetries,
                  idleRetryUsed,
                  redispatchUsed,
                })
                if (retry) {
                  attempt = retry.attempt
                  transientRetries = retry.transientRetries
                  idleRetryUsed = retry.idleRetryUsed
                  redispatchUsed = retry.redispatchUsed
                  // An idle replay and a sealed-attempt re-dispatch go out at
                  // once: nothing is rate-limiting them and the new attempt
                  // number already makes the request distinct.
                  const delay =
                    action.type === "retry-idle" || action.type === "redispatch"
                      ? 0
                      : SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                  if (action.type === "retry-idle") {
                    // Nothing crossed the tool-execution boundary, so replay is
                    // safe. Retire partial provider output before retrying and
                    // persist an explicit boundary for crash recovery and audit.
                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    for (const part of parts) {
                      if (part.type === "text" && !part.synthetic && !part.ignored) {
                        await Session.updatePart({ ...part, ignored: true, time: finishTime(part.time) })
                        continue
                      }
                      if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") {
                        continue
                      }
                      await Session.updatePart({
                        ...part,
                        state: {
                          ...part.state,
                          status: "error",
                          error: "Provider became idle before tool execution started; no action was taken.",
                          time: finishTime("time" in part.state ? part.state.time : undefined),
                        },
                      })
                      toolOutcomes.abandon(part.callID)
                    }
                    await Session.updatePart({
                      id: Identifier.ascending("part"),
                      messageID: input.assistantMessage.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      ignored: true,
                      text: "Provider idle recovery boundary: partial output was retired before one automatic side-effect-free retry.",
                      time: { start: Date.now(), end: Date.now() },
                    } satisfies MessageV2.TextPart)
                  }
                  await SessionTraceStore.recordRetry({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.id,
                    attempt,
                    message: action.message,
                    delayMs: delay,
                  })
                  SessionStatus.set(input.sessionID, {
                    type: "retry",
                    attempt,
                    message: action.message,
                    next: Date.now() + delay,
                  })
                  await SessionRetry.sleep(delay, input.abort).catch(() => {})
                  continue
                }
              }
              if (action.type === "drain") {
                log.warn("provider stream ended after tool execution started; draining authoritative tool outcome", {
                  sessionID: input.sessionID,
                  error: error.name,
                })
              }
              if (action.type !== "drain") input.assistantMessage.error = error
              // A user-initiated abort is a clean cancellation, not a failure —
              // record it on the message but don't fire the session Error event.
              if (action.type !== "drain" && !MessageV2.AbortedError.isInstance(error)) {
                Bus.publish(Session.Event.Error, {
                  sessionID: input.assistantMessage.sessionID,
                  error: input.assistantMessage.error,
                })
              }
            }
          }
          // `fullStream` can close without a terminal tool-result even though
          // the SDK already started execute(). Do not publish a completed
          // assistant turn until those authoritative execute promises settle.
          await toolOutcomes.drain()
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              if (await toolOutcomes.reconcile(part)) continue
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: overflow
                    ? "Model output was truncated before the tool call completed (context limit); no action was taken. Compacting and retrying."
                    : "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
              toolOutcomes.abandon(part.callID)
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          progress(input.assistantMessage.error ? "error" : "done")
          if (overflow) return "overflow"
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
