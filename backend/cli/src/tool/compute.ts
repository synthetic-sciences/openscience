import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { ComputeMode } from "@/compute/mode"
import { Lease } from "@/compute/lease"
import { Global } from "@/global"

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

/**
 * Human text for an unconfirmed teardown, shared between `compute_launch`'s
 * timeout-release path (`ComputeLaunch.expired`) and `compute_release`
 * itself (`ComputeRelease`) — both call `Lease.release` and both have to
 * explain the same four `release_state` codes (see the verified wire shape
 * on `Lease.Released` in compute/lease.ts). Prefers Atlas's own prose
 * (`warning`, only ever present for the two reasons that actually reached
 * the provider) and names the reason in plain language for the two that
 * never did, rather than printing an opaque code with nothing to say about
 * it.
 */
function teardownNote(state: string, warning?: string): string {
  if (warning) return warning
  if (state === "credential_unavailable")
    return "Atlas could not load the credentials that own this box, so it was never even asked to tear it down."
  if (state === "not_configured")
    return "Atlas has no working operator credential for this provider right now, so it could not ask it to tear the box down."
  if (state === "provider_unavailable")
    return "This provider is not registered on the server right now, so nothing could be asked to tear the box down."
  return `Atlas asked the provider and it did not confirm (release_state: ${state}).`
}

/**
 * `compute_launch` — the one tool here that spends money and hands the agent a
 * machine. Everything else in this file exists to keep it from being called
 * when it should not be.
 *
 * The whole flow lives in `run` rather than in the tool's `execute` for the
 * same reason `Lease` takes a `base` parameter: `API_BASE` is a top-level
 * constant resolved at import time, so the only honest way to exercise this
 * against a real HTTP server (AGENTS.md forbids mocks) is a seam the module
 * accepts on purpose. `execute` calls `run` with no options and gets exactly
 * the production defaults.
 */
export namespace ComputeLaunch {
  /**
   * The poll schedule, and why these three numbers.
   *
   * Every poll is an uncached provider HTTP GET on Atlas's side —
   * `lease_manager.get_lease_connection` calls `provider.connection()` on each
   * one — charged against the OPERATOR's rate-limited provider account, not
   * this user's. That is why a flat interval is wrong even though Atlas's own
   * 600/min read limit would happily allow one: the cost is paid by someone
   * who is not in this session.
   *
   * `first: 5s`, and deliberately not an immediate probe. The launch response
   * already said `provisioning` with a null host, and readiness is measured at
   * t+20–30s, so a probe at t=0 costs a provider call to hear an answer that
   * is known in advance.
   *
   * `factor: 1.25`, gentle on purpose. Probes land at 5, 11, 19, 29, 41, 56,
   * 75, 99, 129s…, so a typical 20–30s boot is noticed within about 4s of the
   * box becoming usable. A steeper curve loses exactly the common case: at 2×
   * the fourth probe is at 75s, a 50-second wait on a box that came up at 25.
   *
   * `max: 30s`, because past roughly two minutes the lease is in the long tail
   * — measured Vast boots run past six minutes, and one deploy saw `ready` at
   * 788s — where a tighter ceiling buys nothing but provider calls. A
   * ten-minute boot costs ~25 polls on this schedule against ~120 at a flat 5s.
   *
   * None of these is the DEADLINE. The bound always comes from the launch
   * response's `provisioning_timeout_seconds`; a client bound shorter than the
   * server's abandons launches the server was still completing.
   */
  export interface Poll {
    first: number
    factor: number
    max: number
  }

  export const POLL: Poll = { first: 5_000, factor: 1.25, max: 30_000 }

  export interface Options {
    base?: string
    poll?: Poll
  }

  /**
   * One flat shape for every ending, so a caller reads `outcome` first and
   * only then the fields that ending carries.
   *
   * - `ready` — the box is up and reachable. The only ending that hands over a
   *   machine.
   * - `refused` — nothing was leased. No key was written and no lease exists.
   * - `terminated` — the launch died while provisioning. Nothing to release.
   * - `timed_out` — the server's own bound elapsed with the lease still not
   *   ready; `released` says what became of it.
   * - `interrupted` — the caller aborted mid-poll. The lease is left alone.
   * - `unpollable` — the lease exists but its state cannot be read.
   */
  export type Report = {
    outcome: "ready" | "refused" | "terminated" | "timed_out" | "interrupted" | "unpollable"
    lease_id?: string
    provider?: string
    gpu_model?: string | null
    gpu_name?: string
    gpu_count?: number
    ssh_host?: string
    ssh_port?: number
    ssh_user?: string
    ssh_command?: string
    key_path?: string
    hourly_cents?: number
    effective_cap_cents?: number | null
    error?: Lease.Failure["kind"]
    affordable_budget_cents?: number
    released?: "released" | "already_released" | "failed"
    warning?: string
    release_state?: string
    polls?: number
    status?: string
  }

  export interface Result {
    title: string
    output: string
    metadata: Report
  }

  export const Parameters = z.object({
    gpu: z.string().describe("Canonical GPU model id, e.g. H100-SXM, A100-80GB, L40S, RTX-4090. Not a provider SKU."),
    count: z.number().int().min(1).describe("How many of that GPU on a single box."),
    budget_cents: z
      .number()
      .int()
      .min(1)
      .describe(
        "Hard ceiling in cents for the WHOLE lease, not per hour. Required: omitting it would authorise the entire 24h plan TTL at the hourly rate. Atlas clamps it to the wallet and reports what was really authorised.",
      ),
    max_hourly_cents: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Refuse any offer dearer than this per hour. Leave unset to take the cheapest match."),
  })

  /**
   * Where the private keys live, and why.
   *
   * `<Global.Path.config>/compute/<lease_id>.pem`. Config, not cache — the
   * cache directory is swept wholesale on a version bump (see global/index.ts)
   * and a private key that disappears there strands a box that is still
   * billing. Named for the lease rather than the session, because one agent
   * can hold several leases at once and they are released one at a time.
   *
   * Exported because `compute_release` (Task 3) has to delete the same file
   * this wrote, and two independent spellings of one path is a defect waiting
   * to happen.
   */
  export function keypath(id: string): string {
    // The lease id becomes a filename. Atlas mints `lease_<hex>`, but a path
    // join is not where you want to discover that changed.
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "_")
    return path.join(Global.Path.config, "compute", `${/^\.*$/.test(safe) ? "lease" : safe}.pem`)
  }

  export async function run(spec: Lease.Spec, ctx: Tool.Context, options: Options = {}): Promise<Result> {
    // The gate. `PermissionNext.evaluate`'s `ask` default is only consulted
    // when a tool calls this, so a compute_launch without it prompts for
    // nothing — and this is the call that spends the user's money. It runs
    // BEFORE the POST, and a rejection throws, so nothing is leased.
    await ctx.ask({
      permission: "compute_launch",
      patterns: [`${spec.gpu} x${spec.count}`],
      always: [`${spec.gpu} x*`],
      metadata: {
        gpu: spec.gpu,
        count: spec.count,
        budget_cents: spec.budget_cents,
        max_hourly_cents: spec.max_hourly_cents,
      },
    })

    const launched = await Lease.launch(spec, options.base)
    if (!launched.ok) return refused(launched.error)
    const lease = launched.value

    // BEFORE the poll, never after. A crash between here and readiness must
    // not strand a running, billing box whose key was never saved.
    const key = await persist(lease)

    const schedule = options.poll ?? POLL
    const bound = Date.now() + lease.provisioning_timeout_seconds * 1000
    let wait = schedule.first
    let polls = 0
    while (Date.now() < bound) {
      if (ctx.abort.aborted) return interrupted(lease, key, polls)
      // Clamped so the last probe lands ON the bound rather than past it: it
      // is the final chance to avoid releasing a box that is about to work.
      // Note this sleep is not itself interruptible, so an abort is noticed at
      // the next probe — within one interval, at worst `max`.
      await Bun.sleep(Math.max(0, Math.min(wait, bound - Date.now())))
      polls++
      const probe = await Lease.connection(lease.lease_id, options.base)
      wait = Math.min(wait * schedule.factor, schedule.max)
      if (!probe.ok) {
        // A signed-out client cannot poll and cannot release either, so
        // grinding through the whole bound would only delay telling the user
        // about a box that is already running. Everything else — a provider
        // hiccup, a 500, a dropped connection — is transient by nature and the
        // server's bound is what decides when to give up.
        if (probe.error.kind === "unauthenticated") return unpollable(lease, key, polls, probe.error)
        continue
      }
      const conn = probe.value
      // Never `status`: the raw vocabularies are disjoint across providers and
      // Lambda passes its upstream string through unmapped.
      if (conn.state === "terminated") {
        await discard(key)
        return terminated(lease, conn, polls)
      }
      // `ready` AND a host. The server can promote a lease before a host is
      // backfilled, and coordinates are the whole point of waiting.
      if (conn.state === "ready" && conn.ssh_host) return ready(lease, key, conn, polls)
    }
    return expired(lease, key, polls, options.base)
  }

  // ---------------------------------------------------------------------------
  // Endings
  // ---------------------------------------------------------------------------

  function ready(lease: Lease.Launched, key: string, conn: Lease.Connection, polls: number): Result {
    const command = ssh(key, lease.ssh_user, conn)
    return {
      title: `Leased ${lease.gpu_name} on ${lease.provider}`,
      output: [
        `**lease**: \`${lease.lease_id}\` — ${lease.gpu_count}× ${lease.gpu_name} on ${lease.provider}`,
        `**rate**: ${lease.hourly_rate_cents}¢/hour${cap(lease)}`,
        `**key**: \`${key}\` (0600)`,
        "",
        "```sh",
        command,
        "```",
        "",
        "Do the work over `ssh`/`scp` from bash; nothing runs on that box unless you send it there.",
        "Call `compute_release` the moment you are done — the lease bills every hour until you do, and the cap is a ceiling plus up to ~90 seconds of rate, not an exact stop.",
      ].join("\n"),
      metadata: {
        outcome: "ready",
        lease_id: lease.lease_id,
        provider: lease.provider,
        gpu_model: lease.gpu_model,
        gpu_name: lease.gpu_name,
        gpu_count: lease.gpu_count,
        ssh_host: conn.ssh_host ?? undefined,
        ssh_port: conn.ssh_port,
        ssh_user: lease.ssh_user,
        ssh_command: command,
        key_path: key,
        hourly_cents: lease.hourly_rate_cents,
        effective_cap_cents: lease.effective_budget_cents,
        polls,
      },
    }
  }

  function refused(error: Lease.Failure): Result {
    return {
      title: `Compute launch refused: ${error.kind}`,
      output: [`**launch refused**: ${error.kind}`, error.message, "", advice(error)].join("\n"),
      metadata: {
        outcome: "refused",
        error: error.kind,
        ...("affordable_budget_cents" in error ? { affordable_budget_cents: error.affordable_budget_cents } : {}),
      },
    }
  }

  function terminated(lease: Lease.Launched, conn: Lease.Connection, polls: number): Result {
    return {
      title: `Compute launch died: ${lease.lease_id}`,
      output: [
        `**launch died**: \`${lease.lease_id}\` reported \`terminated\` while provisioning (provider status: \`${conn.status}\`).`,
        "",
        "The server has already ended it, so there is nothing to release and nothing is billing. The key file has been deleted.",
        "This is a provider failing to boot the box, not a configuration error — a second attempt may well land on a different machine.",
      ].join("\n"),
      metadata: {
        outcome: "terminated",
        lease_id: lease.lease_id,
        provider: lease.provider,
        status: conn.status,
        polls,
      },
    }
  }

  /**
   * The bound elapsed with the lease still not ready. Release it: a paid box
   * the agent cannot reach is worse than no box. A `conflict` here is the
   * server having reaped it first, which is a report, not a failure.
   */
  async function expired(lease: Lease.Launched, key: string, polls: number, base?: string): Promise<Result> {
    const released = await Lease.release(lease.lease_id, base)
    const outcome = released.ok ? "released" : released.error.kind === "conflict" ? "already_released" : "failed"
    // An UNCONFIRMED teardown is not a teardown. Atlas reports one honestly
    // (`release_state` on a 2xx) precisely because the provider may not have
    // taken the box down, in which case it is still running, still billing
    // and still holding a concurrency slot — so the key it needs stays on
    // disk and the report does not claim the money stopped. Keyed off
    // `release_state`, never off whether Atlas happened to attach prose:
    // two of its four reasons (`not_configured`, `provider_unavailable`)
    // never call the provider at all, so there is nothing for Atlas to
    // quote even though the box is exactly as unconfirmed as the other two.
    const value = released.ok ? released.value : undefined
    const state = value?.release_state
    const warning = state ? teardownNote(state, value?.warning) : undefined
    const settled = outcome !== "failed" && !state
    if (settled) await discard(key)
    const seconds = lease.provisioning_timeout_seconds
    const note = {
      released:
        "Released it — a paid box you cannot reach is worse than no box. The key file has been deleted, and nothing is billing.",
      already_released:
        "The server had already reaped it, so there was nothing left to release. The key file has been deleted, and nothing is billing.",
      failed: `**The release did NOT go through**, so the box may still be running and billing. Call \`compute_release\` with \`${lease.lease_id}\` yourself. The key file has been left at \`${key}\` in case it comes up.`,
    }[outcome]
    return {
      title: `Compute launch timed out: ${lease.lease_id}`,
      output: [
        `**launch timed out**: \`${lease.lease_id}\` never reported ready inside the ${seconds}s the server allows for provisioning (${polls} polls).`,
        "",
        warning
          ? `Asked the server to release it and it answered, **but the provider teardown was not confirmed**: ${warning}. The box may still be running and billing. Check \`compute_list\` and call \`compute_release\` with \`${lease.lease_id}\` again. Its key has been left at \`${key}\`.`
          : note,
      ].join("\n"),
      metadata: {
        outcome: "timed_out",
        lease_id: lease.lease_id,
        provider: lease.provider,
        released: outcome,
        polls,
        ...(warning ? { warning } : {}),
        ...(state ? { release_state: state } : {}),
        ...(settled ? {} : { key_path: key }),
      },
    }
  }

  function interrupted(lease: Lease.Launched, key: string, polls: number): Result {
    return {
      title: `Compute launch interrupted: ${lease.lease_id}`,
      output: [
        `**interrupted while waiting** for \`${lease.lease_id}\` to come up, after ${polls} polls.`,
        "",
        `The lease was NOT released — it may be seconds from ready, and destroying it is not this tool's call to make on an interruption. Its key is at \`${key}\`.`,
        `Use \`compute_list\` to see whether it came up, and \`compute_release\` with \`${lease.lease_id}\` to give it back. **It bills until you do.**`,
      ].join("\n"),
      metadata: {
        outcome: "interrupted",
        lease_id: lease.lease_id,
        provider: lease.provider,
        key_path: key,
        polls,
      },
    }
  }

  function unpollable(lease: Lease.Launched, key: string, polls: number, error: Lease.Failure): Result {
    return {
      title: `Compute lease unreachable: ${lease.lease_id}`,
      output: [
        `**the lease was created but its state cannot be read**: ${error.message}`,
        "",
        `\`${lease.lease_id}\` is running and billing. Its key is at \`${key}\`.`,
        `Sign in, then use \`compute_list\` to find its address and \`compute_release\` to give it back.`,
      ].join("\n"),
      metadata: {
        outcome: "unpollable",
        lease_id: lease.lease_id,
        provider: lease.provider,
        key_path: key,
        error: error.kind,
        polls,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Modes are load-bearing in both directions here: `ssh` refuses a
   * group-readable private key outright, so 0600 is a functional requirement
   * as much as a security one.
   *
   * `Bun.write()` has no `mode` option — the house style prefers Bun APIs, but
   * here it produces 0644 and a broken feature — so this is node:fs/promises.
   * The explicit `chmod` after each create is not redundant: `mode` is ignored
   * when the target already exists, so a rewrite over a stale loose-permission
   * .pem (or into a pre-existing loose directory) would otherwise stay loose.
   */
  async function persist(lease: Lease.Launched): Promise<string> {
    const dir = path.join(Global.Path.config, "compute")
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.chmod(dir, 0o700)
    const file = keypath(lease.lease_id)
    await fs.writeFile(file, lease.ssh_private_key, { mode: 0o600 })
    await fs.chmod(file, 0o600)
    return file
  }

  /** A key for a lease that is definitively finished is litter with a 0600
   *  mode on it. Only ever called where the lease is known to be gone. */
  async function discard(file: string): Promise<void> {
    await fs.rm(file, { force: true }).catch(() => {})
  }

  /**
   * `-p` is required, not optional: RunPod NATs SSH to a high public port and
   * Vast routes through an ssh-proxy port, so `ssh -i key user@host` simply
   * times out on both. The launch payload's port is always 22, which is why
   * this takes the connection's.
   *
   * `StrictHostKeyChecking=accept-new` because the next step is a
   * non-interactive `bash` call: a freshly minted box has a host key nobody
   * has seen, and the default prompt has no terminal to answer it.
   */
  function ssh(key: string, user: string, conn: Lease.Connection): string {
    const quoted = /[^A-Za-z0-9._/-]/.test(key) ? JSON.stringify(key) : key
    return `ssh -i ${quoted} -p ${conn.ssh_port} -o StrictHostKeyChecking=accept-new ${user}@${conn.ssh_host}`
  }

  function cap(lease: Lease.Launched): string {
    if (lease.effective_budget_cents === null) return " (byok — Atlas is not billing this)"
    const hours = lease.effective_budget_cents / Math.max(1, lease.hourly_rate_cents)
    return `, capped at ${lease.effective_budget_cents}¢ — roughly ${hours.toFixed(1)} hours at this rate`
  }

  /** What the agent should DO about each refusal. Every branch either says
   *  "stop" or names the one action that changes the answer; none of them says
   *  "retry", because no refusal this client can name is fixed by retrying the
   *  same call. */
  function advice(error: Lease.Failure): string {
    switch (error.kind) {
      case "insufficient_credit":
        return `The wallet can back at most ${error.affordable_budget_cents}¢ right now. **Do not relaunch at a smaller budget** — a run truncated to fit the money left is a discarded result, not a cheaper one. Ask the user to top up in Settings ▸ Compute.`
      case "budget_too_low":
        return `That budget cannot fund a single hour at this rate. The wallet can back up to ${error.affordable_budget_cents}¢. Relaunch only with a budget the run can actually finish inside — **do not shrink it to fit**.`
      case "concurrency_capped":
        return "Retrying cannot clear a concurrency cap. Free a slot first: `compute_list` shows what is running and `compute_release` gives one back."
      case "rate_limited":
        return `Too many launches too quickly. Wait ${error.retry_after_seconds ?? 60} seconds before the next attempt; this tool deliberately does not retry on its own, because launches cost money and a retry loop spends it.`
      case "no_matching_offer":
        return "No provider offers that GPU at that count right now. Ask for a different model or a smaller count — the SKU list is Atlas's to pick from, not something to guess at here."
      case "no_capacity":
        return "Every candidate provider was asked and all refused. This is capacity, not configuration: the same request may work later, or a different GPU may work now."
      case "unauthenticated":
        return "Sign in first — no lease was created."
      case "conflict":
        return "Atlas reports this conflicts with a lease that already exists. Check `compute_list` before launching again."
      case "malformed":
        return "Atlas returned a launch this client could not verify, so no key was saved and no lease is being reported — **but a lease may exist server-side**. Run `compute_list` before trying again, and release anything unexpected."
      case "network":
        return "The request never reached Atlas. Nothing was leased. Check connectivity before retrying."
      case "unexpected":
        return `Atlas answered HTTP ${error.status}. Nothing is being reported as leased; run \`compute_list\` before launching again in case one was created.`
    }
  }
}

export const ComputeLaunchTool = Tool.define("compute_launch", {
  description: [
    "Rent a GPU machine and get an SSH command for it. THIS SPENDS THE USER'S MONEY: the lease bills by the hour from the moment it boots until compute_release is called.",
    "Call compute_status first — this only works when compute is funded through managed credits.",
    "Atlas picks the cheapest provider that matches; you name the GPU, the count and the budget, not the provider or the SKU.",
    "Blocks until the box is reachable, which is usually 20-30 seconds and can be several minutes.",
    "Then do the work with plain ssh/scp from bash, and release it as soon as you are done.",
  ].join(" "),
  parameters: ComputeLaunch.Parameters,
  async execute(params, ctx) {
    return ComputeLaunch.run(params, ctx)
  },
})

/**
 * `compute_list` — read-only, no approval gate, so an agent that lost track
 * of a lease (a fresh context, a crash mid-session) can find its boxes
 * again without spending anything to look. Filters to UNFINISHED leases —
 * `status NOT IN ('released', 'failed')`, mirroring
 * `compute_repo.list_unfinished_leases`'s own predicate exactly — because
 * `GET /leases` itself returns a user's whole history, and a list an agent
 * is meant to act on ("what is still billing?") should not make it re-derive
 * that filter by hand.
 *
 * Deliberately does NOT report a per-lease cap: `effective_budget_cents` is
 * computed by the LAUNCH route and attached only to that response, never a
 * column `GET /leases` can return (see `Lease.Summary`'s comment). Rate
 * (`hourly_rate_cents`) and spend (`total_spent_cents`) are on the row and
 * are the honest substitutes.
 */
export namespace ComputeList {
  export interface Row {
    lease_id: string
    provider: string
    gpu_model: string | null
    gpu_name: string | null
    gpu_count: number | null
    status: string
    ssh_host: string | null
    ssh_port: number | null
    hourly_rate_cents: number
    total_spent_cents: number
  }

  export interface Result {
    title: string
    output: string
    metadata: {
      leases: Row[]
      error?: Lease.Failure["kind"]
    }
  }

  const TERMINAL = new Set(["released", "failed"])

  export async function run(base?: string): Promise<Result> {
    const listed = await Lease.list(base)
    if (!listed.ok) return refused(listed.error)
    const unfinished = listed.value.filter((lease) => !TERMINAL.has(lease.status)).map(row)
    return ready(unfinished)
  }

  function row(lease: Lease.Summary): Row {
    return {
      lease_id: lease.lease_id,
      provider: lease.provider,
      gpu_model: lease.gpu_model ?? null,
      gpu_name: lease.gpu_name ?? null,
      gpu_count: lease.gpu_count ?? null,
      status: lease.status,
      ssh_host: lease.ssh_host,
      ssh_port: lease.ssh_port,
      hourly_rate_cents: lease.hourly_rate_cents,
      total_spent_cents: lease.total_spent_cents ?? 0,
    }
  }

  function line(lease: Row): string {
    const gpu = lease.gpu_name
      ? `${lease.gpu_count ?? "?"}× ${lease.gpu_name}${lease.gpu_model ? ` (${lease.gpu_model})` : ""}`
      : "GPU unknown"
    const ssh = lease.ssh_host ? `${lease.ssh_host}:${lease.ssh_port}` : "not yet assigned"
    return `- \`${lease.lease_id}\` — ${gpu} on ${lease.provider} — **${lease.status}** — ssh ${ssh} — ${lease.hourly_rate_cents}¢/hr — spent ${lease.total_spent_cents}¢ so far`
  }

  function ready(leases: Row[]): Result {
    return {
      title: leases.length
        ? `${leases.length} unfinished compute lease${leases.length === 1 ? "" : "s"}`
        : "No unfinished compute leases",
      output: leases.length ? leases.map(line).join("\n") : "No unfinished leases — nothing is billing right now.",
      metadata: { leases },
    }
  }

  function refused(error: Lease.Failure): Result {
    return {
      title: `Could not list compute leases: ${error.kind}`,
      output: [`**could not list leases**: ${error.kind}`, error.message].join("\n"),
      metadata: { leases: [], error: error.kind },
    }
  }
}

export const ComputeListTool = Tool.define("compute_list", {
  description: [
    "List your unfinished GPU compute leases — provisioning or ready, not yet released.",
    "Use this to find a box compute_launch reported earlier (in this session or a previous one) or to check what is still billing before you stop for the day.",
    "Reports rate and spend so far per lease; it cannot report a per-lease budget cap (Atlas does not send one here).",
    "Takes no parameters and spends nothing to call.",
  ].join(" "),
  parameters: z.object({}),
  async execute() {
    return ComputeList.run()
  },
})

/**
 * `compute_release` — gives a lease back. No approval gate: unlike
 * `compute_launch`, this stops money from being spent rather than starting
 * it, and gating the one call that ends billing is the wrong side to add
 * friction to.
 *
 * The whole point of this tool, per the task-3 brief: Atlas now reports an
 * UNCONFIRMED teardown honestly (`Lease.Released.release_state`) instead of
 * a bare 2xx that looks like success either way. A tool that reads only
 * `status` here and calls a 2xx "done" reintroduces exactly the dishonesty
 * the server side was fixed to remove — so `run` reads `release_state`
 * first, and `status` itself decides between two materially different
 * outcomes: `"released"` means billing has stopped even though the box's
 * fate is unconfirmed, and any other status (only ever
 * `credential_unavailable` today) means the lease was not touched at all —
 * the provider was never even asked.
 */
export namespace ComputeRelease {
  export const Parameters = z.object({
    lease_id: z.string().min(1).describe("The lease_id from compute_launch's report or compute_list."),
  })

  export type Outcome = "released" | "unconfirmed" | "not_released" | "already_released" | "refused"

  export interface Result {
    title: string
    output: string
    metadata: {
      outcome: Outcome
      lease_id: string
      status?: string
      release_state?: string
      warning?: string
      error?: Lease.Failure["kind"]
    }
  }

  export async function run(params: { lease_id: string }, base?: string): Promise<Result> {
    const released = await Lease.release(params.lease_id, base)
    if (!released.ok) {
      if (released.error.kind === "conflict") return alreadyReleased(params.lease_id)
      return refused(params.lease_id, released.error)
    }
    return settle(released.value)
  }

  async function settle(value: Lease.Released): Promise<Result> {
    const state = value.release_state
    if (!state) return confirmed(value)
    if (value.status !== "released") return notReleased(value, state)
    return unconfirmed(value, state)
  }

  async function confirmed(value: Lease.Released): Promise<Result> {
    await discard(value.lease_id)
    return {
      title: `Released ${value.lease_id}`,
      output: `**released**: \`${value.lease_id}\` — the provider confirmed the box is gone. Billing has stopped.`,
      metadata: { outcome: "released", lease_id: value.lease_id, status: value.status },
    }
  }

  function unconfirmed(value: Lease.Released, state: string): Result {
    const note = teardownNote(state, value.warning)
    return {
      title: `Released ${value.lease_id}, teardown unconfirmed`,
      output: [
        `**released, but not confirmed**: \`${value.lease_id}\` is marked released — billing has stopped — but the provider did NOT confirm the box is actually gone: ${note}`,
        "",
        "Atlas keeps chasing this on its own retry sweep. Check compute_list later, or call compute_release again, to see if it clears.",
      ].join("\n"),
      metadata: {
        outcome: "unconfirmed",
        lease_id: value.lease_id,
        status: value.status,
        release_state: state,
        warning: note,
      },
    }
  }

  function notReleased(value: Lease.Released, state: string): Result {
    const note = teardownNote(state, value.warning)
    return {
      title: `Could not release ${value.lease_id}`,
      output: [
        `**not released**: \`${value.lease_id}\` is still \`${value.status}\` — Atlas could not even ask the provider to tear it down: ${note}`,
        "",
        "This box is very likely still running. Try compute_release again shortly.",
      ].join("\n"),
      metadata: { outcome: "not_released", lease_id: value.lease_id, status: value.status, release_state: state },
    }
  }

  async function alreadyReleased(lease_id: string): Promise<Result> {
    await discard(lease_id)
    return {
      title: `${lease_id} was already released`,
      output: `**already released**: \`${lease_id}\` was released earlier — there is nothing to do, and nothing is billing.`,
      metadata: { outcome: "already_released", lease_id },
    }
  }

  function refused(lease_id: string, error: Lease.Failure): Result {
    return {
      title: `Release refused: ${error.kind}`,
      output: [`**release refused**: ${error.kind}`, error.message].join("\n"),
      metadata: { outcome: "refused", lease_id, error: error.kind },
    }
  }

  /** A key for a lease Atlas confirms is gone (or was already terminal) is
   *  litter with a 0600 mode on it — the same reasoning `ComputeLaunch`
   *  applies to its own timeout-release path, via the same path. Never
   *  called for `unconfirmed`/`not_released`: the box may still be live and
   *  reachable, and it is exactly the key the agent would need to check. */
  async function discard(lease_id: string): Promise<void> {
    await fs.rm(ComputeLaunch.keypath(lease_id), { force: true }).catch(() => {})
  }
}

export const ComputeReleaseTool = Tool.define("compute_release", {
  description: [
    "Give back a GPU lease so it stops billing. Call this as soon as you are done with a box from compute_launch — leases bill every hour until released.",
    "Surfaces an unconfirmed-teardown warning rather than hiding it: a successful call here does not always mean the provider actually confirmed the box is gone, and this tool never reports one as plain success.",
    "Releasing an already-released lease is reported, not treated as an error.",
  ].join(" "),
  parameters: ComputeRelease.Parameters,
  async execute(params) {
    return ComputeRelease.run(params)
  },
})

export const ComputeTools = [ComputeStatusTool, ComputeLaunchTool, ComputeListTool, ComputeReleaseTool]
