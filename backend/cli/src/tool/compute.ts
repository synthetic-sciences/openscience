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
 *
 * Every string below is bound by one rule: never name a capability that does not
 * exist. That is what mode resolution enforces for `mode` itself, and the
 * guidance text sits one layer above it, where the same defect keeps reappearing
 * in a different shape.
 */

/**
 * The two ways out of a mode that cannot run GPU work, and they are mutually
 * exclusive. `origin` decides which one is true (see ComputeMode.Origin): a
 * config-pinned "managed" makes CONNECT a lie, because `funded()` never reads
 * `providers` and `offered()` returns empty under that override — the key would
 * be connected, ignored, and its skills still hidden.
 */
const CONNECT =
  "Tell the user to connect a provider key in Settings ▸ Compute — a key connected there is picked up on the next call, no restart, and BYOK is the only path that runs GPU work today."
const PINNED =
  '`billing.compute` is pinned to "managed" in the config, so connecting a provider key will not switch this session to byok — the setting has to be changed or removed first.'

function escape(origin: ComputeMode.Origin): string {
  return origin === "config:managed" ? PINNED : CONNECT
}

const BYOK =
  "Run GPU work on the user's connected providers via the cloud-compute skills. Do not launch managed leases — they bill Credits and are not the funded path here."

/**
 * `managed` guidance is a function of balance AND origin, not a fixed string.
 *
 * Balance, because `GET /api/compute/options` reports a provider as managed
 * whenever reselling is on and an operator key exists — availability and
 * affordability are independent there, and live testing against a deployed
 * backend with a zero wallet confirmed it (every lease acquire returns HTTP 402
 * insufficient_cli_credit). Only `balance === 0` counts as unaffordable:
 * acquiring a lease requires an hour of the chosen SKU's rate up front, and
 * rates span cents to dollars an hour depending on a catalog this tool never
 * sees, so any non-zero cutoff would be a guess. `balance === undefined` (the
 * probe succeeded but carried no balance field) is missing information, not an
 * empty wallet, and is left alone.
 *
 * Origin, because the way out differs — see `escape`.
 *
 * Neither branch tells the agent to run the work. THERE IS NO MANAGED LAUNCH
 * MECHANISM IN THIS CLIENT: `ComputeTools` is `[ComputeStatusTool]`, the only
 * `/api/compute` call in the product is mode.ts's read-only `/options` probe,
 * and `compute_launch`/`list`/`release` are Part B, unbuilt (docs/specs/
 * compute-design.md, "The gap Part A exposed"). A funded, keyless user — the
 * default for anyone signed in — was previously told to do the one thing that
 * cannot be done and forbidden the one thing that can.
 *
 * This does NOT change `state.mode`. Managed is genuinely configured; an empty
 * wallet is missing funds and an unbuilt launch path is a missing tool, and
 * neither is a missing capability at the resolution layer. Collapsing them
 * would destroy distinctions the override rule in `ComputeMode.resolve`
 * (narrow, never manufacture) exists to preserve.
 */
function managedGuidance(balance: number | undefined, origin: ComputeMode.Origin): string {
  if (balance === 0)
    return `Managed compute is configured, but the wallet is empty — every lease attempt would be refused (HTTP 402), and OpenScience cannot launch it in any case: this client has no managed-lease command yet, only this status tool. Do not launch GPU work through managed compute. Topping up in Settings ▸ Compute fixes the wallet but not the missing launch path. ${escape(origin)}`
  return `Managed compute is funded, but OpenScience cannot launch it — this client has no managed-lease command yet, only this status tool. Do not launch GPU work through managed compute. ${escape(origin)}`
}

/**
 * No path to `none` is balance-related — `probe()` returns `managed: false`
 * only for no session, a non-2xx response, a network/parse failure, or no
 * provider with `funding: "managed"`, and Atlas reports managed regardless of
 * balance. So "top up for managed compute" was a remedy that could never move a
 * user out of this mode.
 */
function noneGuidance(origin: ComputeMode.Origin): string {
  return `No compute is available. Do not attempt GPU work. ${escape(origin)}`
}

/**
 * Tri-state on purpose. Both byok arms return before the availability probe
 * runs — that skip is the performance win, so there is no verdict to print and
 * "no" would be an unmeasured claim.
 */
function availability(managed: boolean | undefined): string {
  if (managed === undefined) return "not checked (byok takes precedence, so availability was never probed)"
  return managed ? "yes" : "no"
}

function guidance(state: ComputeMode.Resolution): string {
  if (state.mode === "byok") return BYOK
  if (state.mode === "managed") return managedGuidance(state.balance, state.origin)
  return noneGuidance(state.origin)
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
      `**managed available**: ${availability(state.managed)}`,
    ]
    if (state.balance !== undefined) lines.push(`**balance**: $${state.balance.toFixed(2)}`)
    lines.push("", guidance(state))

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
