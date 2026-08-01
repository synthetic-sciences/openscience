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

const GUIDANCE: Record<Exclude<ComputeMode.Source, "managed">, string> = {
  byok: "Run GPU work on the user's connected providers via the cloud-compute skills. Do not launch managed leases — they bill Credits and are not the funded path here.",
  none: "No compute is available. Do not attempt GPU work. Tell the user to connect a provider key in Settings ▸ Compute, or to top up for managed compute.",
}

/**
 * `managed` guidance is a function of balance, not a fixed string, because
 * `GET /api/compute/options` reports a provider as managed whenever reselling
 * is on and an operator key exists — availability and affordability are
 * independent there. Live testing against a deployed backend with a zero
 * wallet found the old fixed string sent the agent down a path that cannot
 * work (every lease acquire returns HTTP 402 insufficient_cli_credit) while
 * simultaneously forbidding the only fallback that would (the user's own
 * provider keys). That is the same "claims a capability with nothing behind
 * it" defect Part A removed from mode resolution itself (see ComputeMode's
 * doc comment) — just one layer up: the mode really is `managed`, the
 * capability exists, but the guidance text assumed `managed` meant funded.
 *
 * This does NOT change `state.mode`. Managed is genuinely configured; an
 * empty wallet is missing funds, not a missing capability, and the two need
 * different advice — top up vs. connect a key. Collapsing them would destroy
 * that distinction, which is exactly the mistake the override rule in
 * `ComputeMode.resolve` (narrow, never manufacture) exists to prevent.
 *
 * Only `balance === 0` counts as unaffordable. Acquiring a lease requires one
 * hour of the chosen SKU's rate up front, and rates span cents to dollars an
 * hour depending on the catalog Atlas holds and this tool never sees — any
 * non-zero cutoff here would be a guess. `balance === undefined` (the probe
 * succeeded but the response carried no balance field) is left alone too:
 * that is missing information, not a zero balance, and treating it as empty
 * would be its own honesty bug.
 */
function managedGuidance(balance: number | undefined): string {
  if (balance === 0)
    return "Managed compute is configured, but the wallet is empty — every lease attempt will be refused (HTTP 402). Tell the user to top up in Settings ▸ Compute, or to connect their own provider key to run BYOK instead."
  return "Run GPU work through managed compute, billed to Credits. Do not use the user's own provider keys — they are not funded here."
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
    lines.push("", state.mode === "managed" ? managedGuidance(state.balance) : GUIDANCE[state.mode])

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
