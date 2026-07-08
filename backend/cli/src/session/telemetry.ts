import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import z from "zod"

// Context-management telemetry (spec P0). Every metric is a bus event so it lands in the
// streamed event contract for free — tests subscribe in-process, the TUI/web client
// receives it over the event channel, and a future `/context` panel can render it with
// no new plumbing. Emission is always on; the paired log line is at DEBUG so it stays
// quiet by default and appears only when debug logging is enabled.
export namespace SessionTelemetry {
  const log = Log.create({ service: "session.telemetry" })

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
  }

  export function recordContext(input: { sessionID: string; composition: MessageV2.Composition }) {
    const c = input.composition
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
    })
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
    const after = input.after ?? (input.before !== undefined ? input.before - input.reclaimed : undefined)
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
    })
  }
}
