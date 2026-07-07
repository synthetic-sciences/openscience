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
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { OpenScience, InsufficientCreditsError } from "@/openscience"
import { requiresWalletBalance, shouldReportUsage, resolveCredentialSource, llmBillingMode } from "./billing-gate"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  // Hard ceiling on transient-error retries within a single message generation.
  // The retry loop is otherwise unbounded, and retry.ts classifies any JSON
  // body carrying an `error` field as retryable — so a persistently-failing
  // provider (or a permanent error arriving as JSON) looped forever.
  const MAX_RETRY_ATTEMPTS = 10
  const log = Log.create({ service: "session.processor" })

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

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            // Check for dashboard-side BYOK/managed changes before each user message.
            await OpenScience.refreshIfStale()

            // Classify the credential backing this call. The wallet pre-flight
            // fires ONLY for managed-proxy credentials (a thk_* token / synced
            // secret). BYOK keys and first-party OAuth subscriptions (Claude
            // Pro/Max, Sign in with ChatGPT, Copilot) run on the user's own
            // account — an empty wallet must never block or gate them.
            const credentialSource = await resolveCredentialSource(input.model.providerID, input.model.id)

            // Managed spend is ON but this call resolved to the user's OWN api
            // key (BYOK) — the wallet isn't wired to it, and silently spending a
            // BYOK key the user set for a different mode is wrong. First-party
            // OAuth subscriptions (Sign in with ChatGPT/Codex, Claude Pro/Max,
            // Copilot) are the user's explicit sign-in and run free of the
            // wallet, so they are NOT gated here.
            if ((await llmBillingMode()) === "managed" && credentialSource === "byok") {
              throw new Error(
                `Managed LLM spend is on, but ${input.model.providerID} isn't available through your Atlas wallet — it resolved to a non-managed key. Switch LLM spend to BYOK in Settings → Spend to use your own key, or pick a managed model.`,
              )
            }

            // Pre-flight wallet check for managed-proxy calls only. Block ONLY on a
            // VERIFIED empty or overdrafted wallet. If the balance can't be verified
            // (null: no/expired Atlas session or a transient error), do NOT hard-block —
            // the managed proxy is the billing authority and returns 402 if actually
            // out of credits. Hard-blocking here strands a user whose session lapsed.
            if (requiresWalletBalance(credentialSource)) {
              const balance = await OpenScience.getBalance()
              if (balance !== null && balance <= 0) {
                // Drop the 30s cache so a top-up is visible on the next
                // attempt instead of blocking until the TTL expires.
                OpenScience.invalidateBalance()
                throw new Error(
                  "Your Atlas wallet is empty. Top up at app.syntheticsciences.ai/cli, or switch LLM spend to BYOK in Settings → Spend — BYOK uses your own key and is never billed.",
                )
              }
            }

            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
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
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
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
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)

                    if (isDoomLoop(parts, value.toolName, value.input)) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
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
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
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
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)

                  // Report usage ONLY for managed-proxy credentials. BYOK keys
                  // and first-party OAuth subscriptions are billed to the user's
                  // own account, not the openscience CLI wallet, so they are never
                  // reported (regardless of the model's nominal models.dev price).
                  const usageResult = !shouldReportUsage(credentialSource)
                    ? null
                    : await OpenScience.reportUsage({
                        service: "llm",
                        event_type: "chat",
                        model: input.model.id,
                        tokens_used: usage.tokens.input + usage.tokens.output + usage.tokens.reasoning,
                        metadata: {
                          provider: input.model.providerID,
                          input_tokens: usage.tokens.input,
                          output_tokens: usage.tokens.output,
                          reasoning_tokens: usage.tokens.reasoning,
                          cache_read: usage.tokens.cache.read,
                          cache_write: usage.tokens.cache.write,
                          cost_usd: usage.cost,
                          session_id: input.sessionID,
                          message_id: input.assistantMessage.id,
                          idempotency_key: stepPartID,
                        },
                      })
                  if (usageResult && "modelBlocked" in usageResult) {
                    log.warn("model blocked by server — halting session", { model: input.model.id })
                    // Hard stop. The user is out of credits (managed
                    // mode) or has no active thesis subscription. The
                    // current step's response is already in their
                    // context; we just don't kick off the next loop.
                    throw new InsufficientCreditsError()
                  }

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
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
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
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
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
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined && attempt < MAX_RETRY_ATTEMPTS) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            // A user-initiated abort is a clean cancellation, not a failure —
            // record it on the message (so the turn stops) but don't fire the
            // session Error event the UI renders as an error state.
            if (!MessageV2.AbortedError.isInstance(error)) {
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
            }
          }
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
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
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
