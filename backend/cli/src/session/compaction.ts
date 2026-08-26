import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { SessionPrompt } from "./prompt"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { SessionTelemetry } from "./telemetry"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import path from "node:path"
import fs from "node:fs/promises"
import { SessionFilesystem } from "./filesystem"
import { SessionLoopState } from "./loop-state"
import { NamedError } from "@synsci/util/error"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  // Fraction of the usable context budget at which auto-compaction fires. 0.75
  // matches Claude Code / opencode: ~25% headroom so the NEXT turn (plus its
  // output) can't blow the hard limit before compaction runs. Overridable via
  // config.compaction.threshold.
  export const DEFAULT_THRESHOLD = 0.75

  // Assumed context window when a provider reports 0 (local / OpenAI-compatible
  // / Codex). Matches the existing unknown-model fallback at provider.ts:770.
  // Overridable via config.compaction.fallbackContext — a small local model
  // (e.g. an 8k Ollama build reporting context 0) should lower it, or proactive
  // compaction never fires until far past its real window.
  export const FALLBACK_CONTEXT = 128_000

  // How many of the most-recent images to keep in full in the model request. Older
  // images are replaced with a text placeholder (they stay on disk, re-readable) so a
  // session that reads many figures can't bloat the window with re-shipped base64.
  export const KEEP_RECENT_IMAGES = 1

  // Flat per-image token cost for pruning decisions. A tool output's TEXT is tiny but
  // its image attachments are ~1-2k tokens each; counting only text made image-heavy
  // outputs invisible to prune. Single source of truth is MessageV2.IMAGE_TOKENS (shared
  // with context-composition telemetry); re-exported here for the prune math.
  export const IMAGE_TOKEN_ESTIMATE = MessageV2.IMAGE_TOKENS

  // Usable context window for a model: total context minus the output reserve. Single
  // source of truth for both the overflow trigger (isOverflow) and the tail budget
  // (process) so the two can never drift. Never reserve more than half the window for
  // output — on a small model (or a small fallbackContext like the 8k the config text
  // recommends) the 32k default output cap exceeds the whole context, so `context - output`
  // goes negative and `count > usable*threshold` is true for ANY count (compact every turn).
  export function usableContext(model: Provider.Model, config: Config.Info): { context: number; usable: number } {
    const context = model.limit.context || config.compaction?.fallbackContext || FALLBACK_CONTEXT
    const cap = Math.min(model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const output = Math.min(cap, Math.floor(context / 2))
    const usable = model.limit.input || context - output
    return { context, usable }
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const { usable } = usableContext(input.model, config)
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const threshold = config.compaction?.threshold ?? DEFAULT_THRESHOLD
    return count > usable * threshold
  }

  // Circuit breaker (P2.5). A compaction that reclaims less than this fraction of the
  // pre-compaction context is "ineffective" — fixed system+tool+summary overhead already
  // dominates the window, so re-compacting won't help. After this many consecutive
  // ineffective compactions we stop proactively compacting for the session and let the
  // reactive overflow-error path be the only backstop — a runaway session can't spin
  // burning tokens on doomed summaries.
  export const EFFECTIVE_COMPACTION_RATIO = 0.1
  export const CIRCUIT_BREAKER_LIMIT = 3

  const breakerState = Instance.state(() => ({}) as Record<string, number>)

  // Record a compaction's effectiveness. An unmeasurable `before` (0/undefined) leaves the
  // counter untouched — we don't punish what we can't judge. Returns whether the breaker
  // is now tripped.
  export function noteCompaction(input: { sessionID: string; before?: number; reclaimed: number }) {
    const state = breakerState()
    if (input.before && input.before > 0) {
      const effective = input.reclaimed / input.before >= EFFECTIVE_COMPACTION_RATIO
      state[input.sessionID] = effective ? 0 : (state[input.sessionID] ?? 0) + 1
    }
    return { tripped: (state[input.sessionID] ?? 0) >= CIRCUIT_BREAKER_LIMIT }
  }

  export function breakerTripped(sessionID: string) {
    return (breakerState()[sessionID] ?? 0) >= CIRCUIT_BREAKER_LIMIT
  }

  export function breakerCount(sessionID: string) {
    return breakerState()[sessionID] ?? 0
  }

  export function resetBreaker(sessionID: string) {
    const reset = (breakerState()[sessionID] ?? 0) > 0
    delete breakerState()[sessionID]
    return reset
  }

  /** Restore the compaction breaker after a backend restart from hidden,
   * ignored markers in the durable session transcript. */
  export function restoreBreaker(sessionID: string, messages: MessageV2.WithParts[]) {
    const count = SessionLoopState.breaker(messages, EFFECTIVE_COMPACTION_RATIO)
    if (count > 0) breakerState()[sessionID] = count
    if (count === 0) delete breakerState()[sessionID]
    return { count, tripped: count >= CIRCUIT_BREAKER_LIMIT }
  }

  /** Persist a breaker transition on a user message. Ignored user text is
   * neither rendered nor sent to the provider, but survives compaction and a
   * full backend restart with the rest of the transcript. */
  export async function persistBreaker(input: {
    sessionID: string
    messageID: string
    transaction: string
    before?: number
    reclaimed?: number
    reset?: boolean
  }) {
    await Session.updatePart({
      id: SessionLoopState.partID(input.transaction, input.reset ? "breaker-reset" : "breaker"),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "text",
      text: "",
      synthetic: true,
      ignored: true,
      metadata: input.reset
        ? SessionLoopState.compactionReset(input.transaction)
        : SessionLoopState.compaction({
            transaction: input.transaction,
            before: input.before,
            reclaimed: input.reclaimed ?? 0,
          }),
    } satisfies MessageV2.TextPart)
  }

  export async function continueAfter(user: MessageV2.User) {
    const text =
      "Continue from the 'Next Move' in the handoff above. Trust it as an accurate record — do not re-read files or re-verify completed work unless the immediate step actually requires it. If the Objective is already complete, give the user your result and stop; do NOT start new work, investigations, or analyses they did not ask for."
    const stored = await MessageV2.get({ sessionID: user.sessionID, messageID: user.id })
    if (stored.info.role !== "user" || stored.info.internal?.type !== "compaction") return
    const reserved = stored.info.internal.continuationID
    const id = reserved ?? (await MessageV2.nextMessageID(user.sessionID))
    if (!reserved) {
      stored.info.internal.continuationID = id
      await Session.updateMessage(stored.info)
    }
    const epoch = SessionLoopState.messageEpoch(stored.info) ?? stored.info.id
    const message = await Session.updateMessage({
      id,
      role: "user",
      sessionID: stored.info.sessionID,
      time: {
        created: Date.now(),
      },
      agent: stored.info.agent,
      model: stored.info.model,
      effort: MessageV2.resolveResearchEffort(stored.info.effort),
      ...SessionLoopState.controls(stored.info),
      internal: SessionLoopState.intent({ kind: "compaction", text, epoch, transaction: id }),
    })
    await Session.updatePart({
      id: SessionLoopState.partID(id, "continuation"),
      messageID: message.id,
      sessionID: stored.info.sessionID,
      type: "text",
      synthetic: true,
      metadata: SessionLoopState.continuation("compaction"),
      text,
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    })
    return message
  }

  /** Complete the side effects of one durable compaction transaction. Handoff
   * writes are overwrite-idempotent, the finalization part has a deterministic
   * ID, and automatic continuation is queued only when recovery says it is
   * still required. */
  export async function recover(input: SessionLoopState.PendingCompaction) {
    const current = SessionLoopState.pendingCompaction(
      await Session.messages({ sessionID: input.carrier.info.sessionID }),
    )
    if (
      !current ||
      current.carrier.info.id !== input.carrier.info.id ||
      current.summary.info.id !== input.summary.info.id
    )
      return
    const intent = current.carrier.info.internal
    if (intent?.type !== "compaction") return
    const transaction = intent.transaction || current.carrier.info.id
    const summary = current.summary.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()
    const truncated = current.summary.info.finish === "length"
    if (!summary || truncated) {
      const error = new NamedError.Unknown({
        message: truncated
          ? "Compaction reached the model output limit before the handoff was complete. OpenScience stopped this turn and preserved the original context. Retry /compact with a model that supports a larger output, shorten the request, or start a new session."
          : "Compaction finished without producing a usable summary. OpenScience stopped this turn and preserved the original context. Retry /compact with a different model, shorten the request, or start a new session.",
      }).toObject()
      current.summary.info.error = error
      current.summary.info.finish = "stop"
      current.summary.info.time.completed ??= Date.now()
      await Session.updateMessage(current.summary.info)
      Bus.publish(Session.Event.Error, { sessionID: current.carrier.info.sessionID, error })
      return "stop" as const
    }
    const before = intent.before ?? 0
    const reclaimed = Math.max(0, (intent.headTokens ?? before) - Token.estimate(summary))
    const trigger = intent.trigger ?? "manual"
    if (!current.finalized) {
      await persistHandoff({
        root: Instance.worktree,
        sessionID: current.carrier.info.sessionID,
        summary,
        file: intent.handoffFile,
      })
      await Session.updatePart({
        id: SessionLoopState.partID(transaction, "finalization"),
        messageID: current.carrier.info.id,
        sessionID: current.carrier.info.sessionID,
        type: "text",
        text: "",
        synthetic: true,
        ignored: true,
        metadata: SessionLoopState.compactionFinalized({
          transaction,
          summaryID: current.summary.info.id,
          trigger,
          before,
          reclaimed,
        }),
      } satisfies MessageV2.TextPart)
      SessionTelemetry.recordCompaction({
        sessionID: current.carrier.info.sessionID,
        trigger,
        mechanism: "summary",
        before,
        after: Math.max(0, before - reclaimed),
        reclaimed,
      })
      if (trigger !== "manual") {
        noteCompaction({ sessionID: current.carrier.info.sessionID, before, reclaimed })
      }
    }
    if (current.continuation) await continueAfter(current.carrier.info)
    return "continue" as const
  }

  // Newest prior handoff text in the transcript, or undefined if this session has never
  // been compacted before. Walking backwards finds the most recent summary message without
  // scanning the whole (potentially long) history once one is found.
  export function previousSummary(messages: MessageV2.WithParts[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info
      if (
        info.role === "assistant" &&
        info.summary &&
        info.finish &&
        info.finish !== "compact" &&
        info.finish !== "length" &&
        !info.error
      ) {
        const text = messages[i].parts
          .filter((p) => p.type === "text")
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("")
          .trim()
        if (text) return text
      }
    }
    return undefined
  }

  const HANDOFF_STRUCTURE = `## Objective
- [the user's EXPLICIT request — what THEY actually asked for, verbatim if short. NOT tangents, hunches, anomalies you noticed, or follow-up ideas you had while working]

## Constraints & Decisions
- [rules/preferences that must hold, decisions made and WHY, key assumptions — the things a fresh agent would otherwise get wrong]

## Work State
### Done (verified)
- [completed & verified work with the concrete result, so it need not be re-checked]
### In progress
- [what is partially done and exactly where it stands]
### Blocked / open
- [blockers, failing checks, unresolved questions]

### Delegated evidence
- [child session/profile — outcome; decisive findings and evidence; exact artifact/file references; material limitation. Preserve this even when the original Task output was reduced. Write "(none)" if no child work informed the result]

## Next Move
1. [the next action REQUIRED to fulfill the Objective — nothing else. Do NOT introduce new goals, investigations, files, or analyses the user did not explicitly ask for. If the Objective is already satisfied, write exactly: "Objective complete — report the result to the user and stop."]
2. [the action after that, only if it too is required by the Objective]

## Key Files & Artifacts
- [path — what it holds and why it matters; read it ONLY if the Next Move needs it]`

  const HANDOFF_RULES = `Preserve exact file paths, commands, identifiers, error strings, and numeric results verbatim. Use terse bullets, not prose. Do not mention that context was compacted or that you are summarizing. Do not ask questions. Do NOT invent work the user did not request — a handoff that adds goals beyond the Objective sends the next agent off-task.`

  // The summary IS a handoff: it becomes the ONLY context the resumed (or a fresh) agent
  // has. When a prior handoff already exists (this session has been compacted before), we
  // UPDATE it rather than regenerate from scratch — regenerating from the full transcript
  // every time lets still-true facts drift or get dropped, and costs a full re-summarization
  // pass. Anchoring on the previous handoff keeps it stable across repeated compactions.
  export function buildHandoffPrompt(opts: { previousSummary?: string; focus?: string }): string {
    const focus = opts.focus?.trim()
      ? `\n\nThe next session will focus on: ${opts.focus.trim()}. Tailor the handoff toward that.`
      : ""
    const head = opts.previousSummary
      ? `You are UPDATING an existing handoff, not writing a new one. New conversation turns have happened since it was written; fold them in.

Update the handoff below. PRESERVE still-true items verbatim; move \`In progress\` items to \`Done (verified)\` once completed; move resolved blockers out of \`Blocked / open\`; drop stale detail; append genuinely new facts. Keep the Objective bound to the user's EXPLICIT request — do not broaden it. Re-emit the exact same Markdown structure below (keep every section; write "(none)" when empty).

<previous-summary>
${opts.previousSummary}
</previous-summary>`
      : `Write a self-contained handoff so another agent can continue this work WITHOUT re-reading the files or re-deriving state. This handoff is the ONLY context that agent will have — capture everything needed to act, and nothing more.

Output exactly this Markdown structure, keeping every section (write "(none)" when a section is empty).`
    return `${head}\n\n${HANDOFF_STRUCTURE}\n\n${HANDOFF_RULES}${focus}`
  }

  /**
   * Persist a handoff only when the caller carries an explicit `/handoff`
   * marker. An empty `file` is intentional: it selects the managed per-session
   * destination, while `undefined` means ordinary manual or automatic
   * compaction and must leave the user's repository untouched.
   */
  export async function persistHandoff(input: { root: string; sessionID: string; summary: string; file?: string }) {
    if (input.file === undefined) return
    const root = path.resolve(input.root)
    const custom = input.file.trim()
    const fallback = path.resolve(root, ".openscience", "handoffs", `${input.sessionID}.md`)
    // Confine a user-supplied /handoff path to the worktree (no absolute / ".."
    // escape); on escape, fall back to the managed per-session file.
    const resolved = custom ? path.resolve(root, custom) : fallback
    const target = resolved.startsWith(root + path.sep) ? resolved : fallback
    const approved = await SessionFilesystem.authorize({
      sessionID: input.sessionID,
      path: target,
      access: "write",
    })
    const ignore = !custom
      ? await SessionFilesystem.authorize({
          sessionID: input.sessionID,
          path: path.join(path.dirname(fallback), ".gitignore"),
          access: "write",
        })
      : undefined
    await fs.mkdir(path.dirname(approved.path), { recursive: true })
    // The managed destination stays out of git status. This write is part of
    // the explicit `/handoff` action; compaction alone never creates it.
    if (ignore) await Bun.write(ignore.path, "*\n")
    await Bun.write(approved.path, input.summary.trimEnd() + "\n")
  }

  // How many recent turns (user message + its following assistant/tool messages) to
  // keep verbatim during compaction, and the token budget that bounds them. A turn is
  // always kept even when it alone exceeds tailTokens — see selectTail's force-last-user
  // guarantee. Overridable via config.compaction.tailTurns / tailTokens.
  export const TAIL_TURNS = 2
  export const TAIL_TOKENS_MIN = 8_000
  export const TAIL_TOKENS_MAX = 32_000

  // Token estimate for one message, mirroring what toModelMessages actually SHIPS so
  // selectTail sizes the verbatim tail against reality: a compacted tool call counts its
  // 1-line summary + truncated args (not the cleared body), images are the flat estimate,
  // and NON-image file/attachment payloads (a PDF's base64) are counted by size instead of
  // silently 0 — a huge PDF turn must not look tiny to the tail budget. (Superseded/dedupe
  // is cross-message state selectTail doesn't have; the tail is recent, where a part is the
  // kept first copy, not a later duplicate — so ignoring it only rarely over-counts.)
  export function messageTokens(msg: MessageV2.WithParts): number {
    let total = 0
    for (const part of msg.parts) {
      if (part.type === "text") {
        if (!part.ignored) total += Token.estimate(part.text)
        continue
      }
      if (part.type === "reasoning") {
        total += Token.estimate(part.text)
        continue
      }
      if (part.type === "file") {
        // text/plain + directory files are folded into text upstream, not shipped as files.
        if (part.mime === "text/plain" || part.mime === "application/x-directory") continue
        total += part.mime.startsWith("image/") ? MessageV2.imageTokens(part.url) : Token.estimate(part.url)
        continue
      }
      if (part.type === "tool") {
        const compacted = part.state.status === "completed" && !!part.state.time.compacted
        total += Token.estimate(
          JSON.stringify((compacted ? MessageV2.truncateArgs(part.state.input) : part.state.input) ?? {}),
        )
        if (part.state.status === "completed") {
          total += Token.estimate(compacted ? MessageV2.toolSummary(part.tool, part.state) : part.state.output)
          if (!compacted)
            for (const a of part.state.attachments ?? [])
              total += a.mime.startsWith("image/") ? MessageV2.imageTokens(a.url) : Token.estimate(a.url)
        }
        if (part.state.status === "error") total += Token.estimate(part.state.error)
      }
    }
    return total
  }

  /** Return the transcript span that still belongs to the active, unanswered
   * turn. Multiple ordinary user messages can arrive while a provider call is
   * running; none of them are reducible history until a terminal assistant
   * response has observed them. Tool, output-limit, and overflow turns are
   * deliberately non-terminal because their follow-up still depends on the
   * original request. */
  export function protectedContext(messages: MessageV2.WithParts[], currentID: string) {
    const current = messages.findIndex((message) => message.info.id === currentID && message.info.role === "user")
    if (current < 0) return []
    const terminal = (message: MessageV2.WithParts) => {
      if (message.info.role !== "assistant") return false
      if (message.info.error) return true
      const finish = message.info.finish
      if (!finish || finish === "compact" || finish === "length") return false
      const tool = message.parts.some((part) => part.type === "tool")
      return !MessageV2.isContinuingTurn(finish, tool)
    }
    const answered = new Set(
      messages.flatMap((message) =>
        terminal(message) && message.info.role === "assistant" ? [message.info.parentID] : [],
      ),
    )
    const summary = messages.findLast(
      (message) =>
        message.info.role === "assistant" &&
        message.info.summary === true &&
        terminal(message) &&
        message.parts.some((part) => part.type === "text" && part.text.trim()),
    )
    const compacted = (message: MessageV2.WithParts) => {
      if (!summary || message.info.id >= summary.info.id) return false
      if (summary.info.role !== "assistant" || !summary.info.tailStartId) return true
      return message.info.id < summary.info.tailStartId
    }
    const start = messages.findIndex((message, index) => {
      if (index > current || message.info.role !== "user") return false
      return !answered.has(message.info.id) && !compacted(message)
    })
    if (start < 0) return []
    return messages.slice(start)
  }

  // Split the history into a verbatim recent tail + a head to summarize. Returns the id of
  // the user message the tail begins at. Keeps whole turns (a user message + its following
  // assistant/tool messages) newest-first up to tailTurns, trimmed to the tailTokens budget
  // but never below one turn — so the current request is always kept verbatim. Returns {}
  // when the tail would cover everything or there is nothing older to summarize.
  export function selectTail(
    messages: MessageV2.WithParts[],
    opts: { tailTurns: number; tailTokens: number },
  ): { tailStartId?: string } {
    const turnStarts = messages.flatMap((m, i) => (m.info.role === "user" ? [i] : []))
    if (turnStarts.length < 2) return {}
    const turnSize = (start: number, end: number) => {
      let sum = 0
      for (let i = start; i < end; i++) sum += messageTokens(messages[i])
      return sum
    }
    let tokens = 0
    let cut = messages.length // start index of the oldest kept turn
    let content = 0 // turns with real content kept so far (a bare compaction carrier scores 0)
    for (let t = turnStarts.length - 1; t >= 0; t--) {
      const start = turnStarts[t]
      const end = t + 1 < turnStarts.length ? turnStarts[t + 1] : messages.length
      const size = turnSize(start, end)
      // Keep at least one CONTENT turn — an empty compaction carrier must not consume the
      // exemption, or a large last real turn would be summarized away. Then keep more only
      // within budget and up to tailTurns.
      if (content >= 1 && (content >= opts.tailTurns || tokens + size > opts.tailTokens)) break
      tokens += size
      cut = start
      if (size > 0) content++
    }
    // `tailTurns` and `tailTokens` bound answered history, never still-unanswered
    // input. If several messages were queued during one provider turn, keep that
    // whole active span verbatim so compaction cannot silently turn one of the
    // user's requests into lossy summary prose before the model has seen it.
    const current = messages[turnStarts.at(-1)!].info.id
    const protectedID = protectedContext(messages, current)[0]?.info.id
    const protectedStart = protectedID ? messages.findIndex((message) => message.info.id === protectedID) : -1
    if (protectedStart > 0) cut = Math.min(cut, protectedStart)
    if (cut <= 0 || cut >= messages.length) return {} // tail covers everything / nothing kept
    return { tailStartId: messages[cut].info.id }
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill", "artifact"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return 0
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const images = (part.state.attachments ?? [])
              .filter((attachment) => attachment.mime.startsWith("image/"))
              .reduce((sum, attachment) => sum + MessageV2.imageTokens(attachment.url), 0)
            const estimate = Token.estimate(part.state.output) + images
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
      return pruned
    }
    return 0
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
    focus?: string
    handoffFile?: string
    trigger?: "proactive" | "overflow" | "manual"
    step: number
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    // Split the transcript into a verbatim recent tail + a head to summarize (P3.2). The
    // tail is kept in the CONVERSATION and re-rendered to the conversation's model on the
    // next turn — so size it against THAT model's window, not the compaction agent's (which
    // may be a different, distinctly-configured model). They coincide unless a custom
    // compaction agent.model is set.
    const cfg = await Config.get()
    const convModel = agent.model
      ? await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      : model
    const { usable } = usableContext(convModel, cfg)
    const tailTurns = cfg.compaction?.tailTurns ?? TAIL_TURNS
    const tailTokens =
      cfg.compaction?.tailTokens ?? Math.min(TAIL_TOKENS_MAX, Math.max(TAIL_TOKENS_MIN, Math.floor(usable * 0.2)))
    const { tailStartId } = selectTail(input.messages, { tailTurns, tailTokens })
    const tailIdx = tailStartId ? input.messages.findIndex((m) => m.info.id === tailStartId) : -1
    const head = tailIdx > 0 ? input.messages.slice(0, tailIdx) : input.messages
    if (userMessage.internal?.type === "compaction") {
      userMessage.internal.before = MessageV2.composition(input.messages).total
      userMessage.internal.headTokens = MessageV2.composition(head).total
      await Session.updateMessage(userMessage)
    }
    const msg = (await Session.updateMessage({
      id: await MessageV2.nextMessageID(input.sessionID),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      ...(tailStartId ? { tailStartId } : {}),
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      internal: { step: input.step },
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
      busyStatus: "compacting",
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    // The summary IS a handoff: it becomes the ONLY context the resumed (or a fresh)
    // agent has. It must be self-contained enough to CONTINUE from without re-reading
    // files or re-deriving state — otherwise the agent burns its whole fresh window
    // catching up and immediately overflows again. A concrete "Next Move" and inline
    // verified results are what let it act instead of re-exploring. When this session has
    // been compacted before, anchor on that prior handoff (update it) instead of
    // regenerating from scratch every time (P3.1).
    const promptText =
      compacting.prompt ??
      [
        buildHandoffPrompt({ previousSummary: previousSummary(input.messages), focus: input.focus }),
        ...compacting.context,
      ].join("\n\n")
    const result = await processor.process({
      // Compaction is an isolated internal call. Preserve the source system
      // controls on the durable carrier for the resumed main turn, but do not
      // replay them into the compaction agent where child/custom guidance can
      // conflict with the handoff contract and consume context twice.
      user: { ...userMessage, system: undefined },
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        // Strip ALL media from the summary request — the summarizer never needs the
        // images and re-ingesting base64 can blow the summary call's own budget. Summarize
        // only the head (P3.2) — the tail is kept verbatim in the transcript and re-spliced
        // back in after the summary via tailStartId/filterCompacted.
        ...MessageV2.toModelMessages(head, model, { stripMedia: true }),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    // The summarization request itself exceeded the context window — no summary
    // was produced. Surface it so the caller fails the turn instead of
    // re-attempting a compaction that can never succeed.
    if (result === "overflow") return "overflow"

    if (result === "continue") {
      const pending = SessionLoopState.pendingCompaction(await Session.messages({ sessionID: input.sessionID }))
      if (pending && (await recover(pending)) === "stop") return "stop"
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      effort: MessageV2.ResearchEffort.optional(),
      delegation: z.boolean().optional(),
      delegationSettings: MessageV2.DelegationSettings.optional(),
      auto: z.boolean(),
      focus: z.string().optional(),
      handoffFile: z.string().optional(),
      trigger: z.enum(["proactive", "overflow", "manual"]).optional(),
      epoch: z.string().optional(),
    }),
    async (input) => {
      const messages = await Session.messages({ sessionID: input.sessionID })
      const previous = messages.findLast(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user",
      )
      const id = await MessageV2.nextMessageID(input.sessionID)
      const epoch = input.epoch ?? (input.auto ? (SessionLoopState.currentEpoch(messages) ?? id) : id)
      const msg = await Session.updateMessage({
        id,
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        effort: input.effort ?? "normal",
        ...(previous ? SessionLoopState.controls(previous.info) : {}),
        delegation: input.delegation ?? previous?.info.delegation,
        delegationSettings: input.delegationSettings ?? previous?.info.delegationSettings,
        internal: {
          type: "compaction",
          auto: input.auto,
          epoch,
          transaction: id,
          focus: input.focus,
          handoffFile: input.handoffFile,
          trigger: input.trigger,
        },
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: SessionLoopState.partID(id, "carrier"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        focus: input.focus,
        handoffFile: input.handoffFile,
        trigger: input.trigger,
      })
    },
  )
}
