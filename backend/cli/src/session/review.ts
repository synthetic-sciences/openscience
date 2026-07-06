import { Config } from "../config/config"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import type { MessageV2 } from "./message-v2"

// WS11 — reviewer gate. A code-level review pass that runs at the session
// loop-exit (see session/prompt.ts), independent of whether the primary agent
// remembered to invoke a review subagent itself. Level 0 is annotate-only and
// non-blocking: run the domain reviewer in a fresh, blind child session and
// append its verdict as a footer note on the finished answer. Off by default
// (config.experimental.reviewGate); a no-op for non-reviewable or trivial turns.
export namespace SessionReview {
  const log = Log.create({ service: "session.review" })

  // Primary/artifact agents whose final answers earn a blind review pass.
  const REVIEWABLE = ["research", "biology", "ml", "physics"]
  // Shortest answer worth reviewing — trivial lookups are skipped.
  const MIN_TEXT = 400

  // Domain-map the caller to the sharpest read-only reviewer we have. Physics
  // gets the Aletheia-blind physics-critique; the artifact agents get the
  // provenance-tracing reviewer; everything else falls back to critique.
  export function reviewerFor(agent: string): string {
    if (agent === "physics") return "physics-critique"
    if (agent === "research" || agent === "biology" || agent === "ml") return "reviewer"
    return "critique"
  }

  // Pure, side-effect-free guard (unit-tested). Only substantive,
  // artifact-bearing answers from a reviewable primary agent qualify.
  export function shouldReview(input: { agent?: string; text: string }): boolean {
    if (!input.agent || !REVIEWABLE.includes(input.agent)) return false
    const text = input.text.trim()
    if (text.length < MIN_TEXT) return false
    // Something concrete to check: a file/artifact path, a file:line citation,
    // or a numeric claim. Prose-only chatter with no checkable fact is skipped.
    return /[\w./-]+\.(?:py|ipynb|md|csv|json|txt|tex|png|pdf|npy|parquet)\b|\bfile:|\d/.test(text)
  }

  function footer(reviewerName: string, verdict: string): string {
    const body = verdict.trim().length > 0 ? verdict.trim() : "No findings returned."
    const quoted = body
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")
    return `\n\n---\n\n> **Reviewer (@${reviewerName})** — blind review of the answer above:\n>\n${quoted}`
  }

  function promptFor(text: string): string {
    return [
      "Blindly review the FINAL ANSWER below. You did not write it; do not trust it.",
      "Independently trace every claim, number, and citation to evidence you can verify from the workspace.",
      "Flag citation mismatches, untraceable numbers, and unsupported claims. Judge integrity, not style.",
      "Keep it short. End with a one-line verdict: `CLEAN` or `FLAGGED (N)` where N counts blocking findings.",
      "",
      "<final_answer>",
      text,
      "</final_answer>",
    ].join("\n")
  }

  // Fire-and-forget after finalize — never throws, never blocks the answer.
  export async function gate(input: {
    sessionID: string
    agent?: string
    model: { providerID: string; modelID: string }
  }): Promise<void> {
    try {
      const config = await Config.get()
      const mode = config.experimental?.reviewGate
      if (!mode || mode === "off") return
      if (!input.agent) return

      // Deferred imports break the session/prompt ↔ session/review cycle.
      const { Session } = await import("./index")
      const { SessionPrompt } = await import("./prompt")

      const messages = await Session.messages({ sessionID: input.sessionID })
      const last = messages.filter((m) => m.info.role === "assistant" && (m.info as MessageV2.Assistant).finish).at(-1)
      if (!last) return
      const text = last.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as MessageV2.TextPart).text)
        .join("\n")
        .trim()
      if (!shouldReview({ agent: input.agent, text })) return

      const reviewerName = reviewerFor(input.agent)
      const child = await Session.create({
        parentID: input.sessionID,
        title: `Review (@${reviewerName})`,
        permission: [
          { permission: "todowrite", pattern: "*", action: "deny" },
          { permission: "todoread", pattern: "*", action: "deny" },
          { permission: "task", pattern: "*", action: "deny" },
        ],
      })

      const parts = await SessionPrompt.resolvePromptParts(promptFor(text))
      const result = await SessionPrompt.prompt({
        messageID: Identifier.ascending("message"),
        sessionID: child.id,
        model: input.model,
        agent: reviewerName,
        tools: { task: false, todowrite: false, todoread: false },
        parts,
      })
      const verdict = result.parts.findLast((p) => p.type === "text")?.text ?? ""

      const now = Date.now()
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: last.info.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: footer(reviewerName, verdict),
        time: { start: now, end: now },
        metadata: { review: { reviewer: reviewerName } },
      })
      log.info("review gate annotated", { sessionID: input.sessionID, reviewer: reviewerName })
    } catch (e) {
      log.warn("review gate error", { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
