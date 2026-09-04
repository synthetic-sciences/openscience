import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"

// Context-management telemetry (spec P0). Every metric is a bus event so it lands in the
// streamed event contract for free — tests subscribe in-process, the TUI/web client
// receives it over the event channel, and a future `/context` panel can render it with
// no new plumbing. Emission is always on; the paired log line is at DEBUG so it stays
// quiet by default and appears only when debug logging is enabled.
export namespace SessionTelemetry {
  const log = Log.create({ service: "session.telemetry" })
  export interface ContextBudget {
    total: number
    newest: number
    history: number
    usable: number
    soft: number
    hard: number
  }
  export interface ContextSnapshot extends ContextBudget {
    composition: MessageV2.Composition
    recordedAt: number
  }
  const latest = new Map<string, ContextSnapshot>()
  const LATEST_LIMIT = 256

  export const RequestPhase = z.enum([
    "connecting",
    "waiting_first_token",
    "streaming",
    "conflict_wait",
    "retry_wait",
    "done",
    "error",
  ])
  export type RequestPhase = z.infer<typeof RequestPhase>

  // Live phase of the provider request behind one assistant message. `since` is
  // when the current phase began; `elapsedMs` is how long the attempt had been
  // running at that moment, so a client can render a skew-free elapsed clock as
  // `elapsedMs + (now - since)`. `firstOutputMs` and `stalls` accumulate across
  // the message so a later trace can show time-to-first-output.
  export const RequestProgress = z
    .object({
      sessionID: z.string(),
      messageID: z.string(),
      attempt: z.number(),
      agent: z.string(),
      providerID: z.string(),
      modelID: z.string(),
      phase: RequestPhase,
      since: z.number(),
      elapsedMs: z.number(),
      retryAfterMs: z.number().optional(),
      detail: z.string().optional(),
      firstOutputMs: z.number().optional(),
      stalls: z.number(),
    })
    .meta({ ref: "SessionRequestProgress" })
  export type RequestProgress = z.infer<typeof RequestProgress>

  const requests = new Map<string, RequestProgress & { started: number }>()

  // A managed-gateway conflict is waited out inside the provider fetch, below
  // the processor, so it reaches the request record through the provider's
  // timing hook. The hook is attached on the first recorded phase rather than
  // at module load: provider -> plugin -> session imports this module, so at
  // load time the Provider namespace may not be initialised yet.
  let hooked = false
  function hook() {
    if (hooked) return
    hooked = true
    Provider.onTiming((timing) => {
      if (timing.outcome !== "conflict_wait" || !timing.conflict) return
      // Only the message that is currently in flight for the session is
      // attributable; a background title request waiting on the gateway must
      // not replace the visible turn's phase.
      const current = requests.get(timing.sessionID)
      if (!current || current.messageID !== timing.messageID) return
      recordProgress({
        sessionID: timing.sessionID,
        messageID: timing.messageID,
        attempt: timing.attempt,
        phase: "conflict_wait",
        retryAfterMs: timing.conflict.delayMs,
        detail: timing.conflict.code,
      })
    })
  }

  export const Event = {
    // Per-turn breakdown of the working context by content type, emitted right before the
    // model call. Makes "what is filling the window" measurable so later phases can show
    // their effect.
    Context: BusEvent.define(
      "session.context",
      z.object({
        sessionID: z.string(),
        tokens: z.object({
          system: z.number(),
          text: z.number(),
          reasoning: z.number(),
          tool: z.number(),
          skills: z.number(),
          image: z.number(),
        }),
        images: z.number(),
        total: z.number(),
        budget: z
          .object({
            total: z.number(),
            newest: z.number(),
            history: z.number(),
            usable: z.number(),
            soft: z.number(),
            hard: z.number(),
          })
          .optional(),
      }),
    ),
    // One event per reclaim mechanism (prune vs LLM summary), tagged with what triggered
    // it and how much it reclaimed — so cheap deterministic reduction (levels 2-3) is
    // attributable separately from the expensive LLM summary (level 4).
    Compaction: BusEvent.define(
      "session.compaction",
      z.object({
        sessionID: z.string(),
        trigger: z.enum(["proactive", "overflow", "manual"]),
        mechanism: z.enum(["prune", "summary"]),
        before: z.number().optional(),
        after: z.number().optional(),
        reclaimed: z.number(),
      }),
    ),
    // Request-phase telemetry for the status line: connecting -> waiting for
    // the first token -> streaming, plus gateway-conflict and retry waits.
    // "streaming" is set by the processor on the first content delta, not on
    // the first body chunk, because a keepalive comment is not output.
    Progress: BusEvent.define("session.request.progress", RequestProgress),
  }

  export function recordContext(input: {
    sessionID: string
    composition: MessageV2.Composition
    budget?: ContextBudget
  }) {
    const c = input.composition
    if (input.budget) {
      if (!latest.has(input.sessionID) && latest.size >= LATEST_LIMIT) {
        const oldest = latest.keys().next()
        if (!oldest.done) latest.delete(oldest.value)
      }
      latest.set(input.sessionID, { ...input.budget, composition: c, recordedAt: Date.now() })
    }
    log.debug("context", {
      sessionID: input.sessionID,
      total: c.total,
      system: c.system,
      text: c.text,
      tool: c.tool,
      image: c.image,
      reasoning: c.reasoning,
      skills: c.skills,
      images: c.images,
    })
    // Fire-and-forget: callers don't await this. Bus.publish rejects if any subscriber
    // throws, so swallow it here — telemetry must never crash the session loop it observes.
    return Bus.publish(Event.Context, {
      sessionID: input.sessionID,
      tokens: {
        system: c.system,
        text: c.text,
        reasoning: c.reasoning,
        tool: c.tool,
        skills: c.skills,
        image: c.image,
      },
      images: c.images,
      total: c.total,
      budget: input.budget,
    }).catch((error) => log.debug("context telemetry publish failed", { error: `${error}` }))
  }

  /** Last exact safe-input preflight recorded immediately before a provider call. */
  export function context(sessionID: string) {
    return latest.get(sessionID)
  }

  /** Publish a request-phase transition. Identity fields omitted by the caller
   * are inherited from the session's current record, so a layer that only knows
   * the session (the retry status, a provider fetch hook) can still report a
   * phase. A repeat of the same phase for the same attempt is a no-op. */
  export function recordProgress(input: {
    sessionID: string
    messageID: string
    attempt: number
    phase: RequestPhase
    agent?: string
    providerID?: string
    modelID?: string
    retryAfterMs?: number
    detail?: string
  }) {
    hook()
    const prior = requests.get(input.sessionID)
    const same = prior?.messageID === input.messageID ? prior : undefined
    // Cheap enough to call on every stream delta: a repeat returns before the
    // clock is read.
    if (same && same.phase === input.phase && same.attempt === input.attempt) return same
    const now = Date.now()
    const started = input.phase === "connecting" || !same ? now : same.started
    const stall = input.phase === "conflict_wait" || input.phase === "retry_wait" ? 1 : 0
    const elapsedMs = now - started
    const first = same?.firstOutputMs ?? (input.phase === "streaming" ? elapsedMs : undefined)
    const item = {
      sessionID: input.sessionID,
      messageID: input.messageID,
      attempt: input.attempt,
      agent: input.agent ?? same?.agent ?? "unknown",
      providerID: input.providerID ?? same?.providerID ?? "unknown",
      modelID: input.modelID ?? same?.modelID ?? "unknown",
      phase: input.phase,
      since: now,
      elapsedMs,
      ...(input.retryAfterMs !== undefined && { retryAfterMs: Math.max(0, input.retryAfterMs) }),
      ...(input.detail && { detail: input.detail }),
      ...(first !== undefined && { firstOutputMs: first }),
      stalls: (same?.stalls ?? 0) + stall,
    } satisfies RequestProgress
    if (!prior) trim()
    // Delete first so the map is ordered by last update rather than first
    // insertion: a long-lived session is never the eviction candidate just
    // because it started before 256 newer ones.
    requests.delete(input.sessionID)
    requests.set(input.sessionID, { ...item, started })
    log.debug("request progress", {
      sessionID: item.sessionID,
      messageID: item.messageID,
      attempt: item.attempt,
      phase: item.phase,
      elapsedMs: item.elapsedMs,
      retryAfterMs: item.retryAfterMs,
      firstOutputMs: item.firstOutputMs,
      stalls: item.stalls,
    })
    void Bus.publish(Event.Progress, item).catch((error) =>
      log.debug("request progress publish failed", { error: `${error}` }),
    )
    return item
  }

  /** Make room for one more request record: a finished request goes first,
   * then the least recently updated one. */
  function trim() {
    if (requests.size < LATEST_LIMIT) return
    for (const [key, item] of requests) {
      if (item.phase !== "done" && item.phase !== "error") continue
      requests.delete(key)
      return
    }
    const oldest = requests.keys().next()
    if (!oldest.done) requests.delete(oldest.value)
  }

  /** Latest request-phase record for a session, including time-to-first-output. */
  export function progress(sessionID: string): RequestProgress | undefined {
    const item = requests.get(sessionID)
    if (!item) return
    const { started: _, ...rest } = item
    return rest
  }

  export function recordCompaction(input: {
    sessionID: string
    trigger: "proactive" | "overflow" | "manual"
    mechanism: "prune" | "summary"
    reclaimed: number
    before?: number
    after?: number
  }) {
    // When the caller knows only the reclaimed amount (the prune path returns just that),
    // derive `after` from `before` so consumers always get a consistent before/after/delta.
    // Clamp at 0: `before` (real provider tokens) and `reclaimed` (a local estimate over the
    // pruned history) use different bases, so the estimate can exceed `before` — a context
    // size is never negative.
    const rawAfter = input.after ?? (input.before !== undefined ? input.before - input.reclaimed : undefined)
    const after = rawAfter !== undefined ? Math.max(0, rawAfter) : undefined
    log.debug("compaction", {
      sessionID: input.sessionID,
      trigger: input.trigger,
      mechanism: input.mechanism,
      before: input.before,
      after,
      reclaimed: input.reclaimed,
    })
    return Bus.publish(Event.Compaction, {
      sessionID: input.sessionID,
      trigger: input.trigger,
      mechanism: input.mechanism,
      before: input.before,
      after,
      reclaimed: input.reclaimed,
    }).catch((error) => log.debug("compaction telemetry publish failed", { error: `${error}` }))
  }
}
