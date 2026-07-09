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
  export const KEEP_RECENT_IMAGES = 5

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

  export function resetBreaker(sessionID: string) {
    delete breakerState()[sessionID]
  }

  // Newest prior handoff text in the transcript, or undefined if this session has never
  // been compacted before. Walking backwards finds the most recent summary message without
  // scanning the whole (potentially long) history once one is found.
  export function previousSummary(messages: MessageV2.WithParts[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info
      if (info.role === "assistant" && info.summary) {
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
        total += part.mime.startsWith("image/") ? IMAGE_TOKEN_ESTIMATE : Token.estimate(part.url)
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
              total += a.mime.startsWith("image/") ? IMAGE_TOKEN_ESTIMATE : Token.estimate(a.url)
        }
        if (part.state.status === "error") total += Token.estimate(part.state.error)
      }
    }
    return total
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
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        // Preserve RLM state blocks — they carry planner progress
        if (part.type === "text" && part.text.includes("<rlm_state>")) continue
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const images = (part.state.attachments ?? []).filter((a) => a.mime.startsWith("image/")).length
            const estimate = Token.estimate(part.state.output) + images * IMAGE_TOKEN_ESTIMATE
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
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
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
      user: userMessage,
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

    // Persist the handoff so a fresh agent/process can pick up from one curated file
    // instead of re-reading the whole project. Default is a PER-SESSION file at
    // .openscience/handoffs/<sessionID>.md — one writer per file, so parallel sessions
    // and subagents never clobber each other (no shared mutable "latest"; the caller
    // knows its session id, and a human can `ls -t` for the newest). /handoff <path>
    // overrides with an explicit file. Best-effort — a write failure never blocks it.
    if (result === "continue") {
      const summaryText = (await MessageV2.parts(msg.id))
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim()
      if (summaryText) {
        // Summary telemetry: `before` is the size of the history being compressed, `after`
        // the size of the summary that replaces it. Attributes the expensive LLM-summary
        // reclamation (level 4) separately from the cheap prune (level 3).
        const summaryTokens = Token.estimate(summaryText)
        const before = MessageV2.composition(input.messages).total
        // P3.2 keeps the tail verbatim — only `head` is replaced by the summary, so reclaimed
        // is head−summary (not full−summary), keeping the P2.5 breaker + telemetry honest.
        const reclaimed = Math.max(0, MessageV2.composition(head).total - summaryTokens)
        const after = before - reclaimed
        SessionTelemetry.recordCompaction({
          sessionID: input.sessionID,
          trigger: input.trigger ?? "manual",
          mechanism: "summary",
          before,
          after,
          reclaimed,
        })
        // Feed the circuit breaker: repeated low-yield summaries trip it (P2.5). Only
        // AUTOMATIC compactions count — a manual /compact reclaiming little (fixed overhead
        // dominates) must not trip the breaker that gates PROACTIVE auto-compaction, or a
        // few manual runs would silently disable auto-compaction for the session.
        if ((input.trigger ?? "manual") !== "manual") noteCompaction({ sessionID: input.sessionID, before, reclaimed })
        const root = path.resolve(Instance.worktree)
        const custom = input.handoffFile?.trim()
        const defaultTarget = path.resolve(root, ".openscience", "handoffs", `${input.sessionID}.md`)
        // Confine a user-supplied /handoff path to the worktree (no absolute / ".."
        // escape); on escape, fall back to the default per-session file.
        const resolved = custom ? path.resolve(root, custom) : defaultTarget
        const target = resolved.startsWith(root + path.sep) ? resolved : defaultTarget
        // Self-ignoring dir so per-session handoffs never show up in `git status`.
        if (!custom) await Bun.write(path.join(path.dirname(defaultTarget), ".gitignore"), "*\n").catch(() => {})
        await Bun.write(target, summaryText + "\n").catch((e) =>
          log.warn("failed to write handoff file", { target, error: e instanceof Error ? e.message : String(e) }),
        )
      }
    }

    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue from the 'Next Move' in the handoff above. Trust it as an accurate record — do not re-read files or re-verify completed work unless the immediate step actually requires it. If the Objective is already complete, give the user your result and stop; do NOT start new work, investigations, or analyses they did not ask for.",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
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
      auto: z.boolean(),
      focus: z.string().optional(),
      handoffFile: z.string().optional(),
      trigger: z.enum(["proactive", "overflow", "manual"]).optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
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
