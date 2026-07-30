import z from "zod"
import { Tool } from "./tool"
import { ComputeMode } from "@/compute/mode"

/**
 * The agent PULLS its compute mode from here; nothing is injected per turn.
 *
 * An earlier design injected mode guidance into every turn. That was wrong for a
 * reason that matters more than token cost: the mode changes mid-session. A user
 * connects a Modal key in Settings ▸ Compute while a session is running, and a
 * reminder injected at turn 3 is false by turn 12. A tool returns the state at
 * the moment it is asked.
 *
 * The DESCRIPTION carries the constraint — it reaches the agent before it starts
 * down a path, which is the one thing an injection did well, and tool definitions
 * are in every request regardless, so it costs nothing extra. The RESULT carries
 * the specifics. Adding rates or a balance to an every-turn injection would be
 * expensive; adding them here is free.
 */

const GUIDANCE: Record<ComputeMode.Source, string> = {
  byok: "Run GPU work on the user's connected providers via the cloud-compute skills. Do not launch managed leases — they bill Credits and are not the funded path here.",
  managed:
    "Run GPU work through managed compute, billed to Credits. Do not use the user's own provider keys — they are not funded here.",
  none: "No compute is available. Do not attempt GPU work. Tell the user to connect a provider key in Settings ▸ Compute, or to top up for managed compute.",
}

export const ComputeStatusTool = Tool.define("compute_status", {
  description: [
    "Check how GPU compute is funded before running any GPU, training, or cluster work.",
    "Returns one of byok, managed, or none, the providers available, and the rule that applies.",
    "Call this first — the answer can change mid-session as the user connects or removes keys.",
  ].join(" "),
  parameters: z.object({}),
  async execute(_params, _ctx) {
    const state = await ComputeMode.resolve()
    const lines = [
      `**mode**: ${state.mode}`,
      `**providers**: ${state.providers.length ? state.providers.join(", ") : "none configured"}`,
      `**managed available**: ${state.managed ? "yes" : "no"}`,
    ]
    if (state.balance !== undefined) lines.push(`**balance**: $${state.balance.toFixed(2)}`)
    lines.push("", GUIDANCE[state.mode])

    return {
      title: `Compute: ${state.mode}`,
      output: lines.join("\n"),
      metadata: {
        mode: state.mode,
        providers: state.providers,
        managed_available: state.managed,
        balance_usd: state.balance,
      },
    }
  },
})

export const ComputeTools = [ComputeStatusTool]
