/**
 * PROTOTYPE — throwaway. Not wired into the product. Delete or lift, don't ship.
 *
 * ── The question ────────────────────────────────────────────────────────────
 * We want managed GPU compute where the AGENT PROPOSES a duration and ATLAS
 * DECIDES whether it can be afforded — because OpenScience is open-source, so a
 * decision made client-side is a decision a fork can delete.
 *
 * Does that state machine hold together? Four sub-questions:
 *   (a) what must an agent see to propose a sensible duration?
 *   (b) what does a rejection look like, and can the agent act on it?
 *   (c) what happens at the deadline, and who actually enforces it?
 *   (d) what does the client do when release fails or can't be confirmed?
 *
 * ── What is real vs modelled ────────────────────────────────────────────────
 * Atlas today (read from ~/codes/InkVell/atlas, origin/main):
 *   - POST /api/compute/estimate returns a RATE only. No duration, no total.
 *   - POST /api/compute/leases has NO duration field and NO expires_at column.
 *     It derives a flat 24h TTL from the user's plan, and verifies the wallet
 *     can fund ONE HOUR (402 otherwise).
 *   - The only server clocks are that 24h TTL and a 10-min heartbeat check.
 *   - All four leasable providers silently DISCARD the timeout argument, so
 *     provider-native auto-termination does not exist. Something must call
 *     release, or the VM runs on.
 *
 * That last group is why this prototype exists: it lets you toggle each
 * assumption and watch the money.
 *
 * NOTE: the Atlas code above was read but NOT verified at runtime, so this
 * models its apparent behaviour, not confirmed behaviour.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** What the agent asks for. Untrusted — it only ever proposes. */
export interface Proposal {
  provider: string
  sku: string
  /** The agent's own guess at how long the work needs. */
  hours: number
}

/** What Atlas returns from /estimate today: a rate, and nothing about duration. */
export interface Quote {
  funding: "managed" | "byok" | "unavailable"
  rateCentsPerHour: number
  balanceCents: number
}

/**
 * Which affordability rule the server applies.
 *  - "first-hour" is what Atlas does TODAY: can you fund one hour?
 *  - "total" is the proposed change: can you fund rate x approved_hours?
 * Toggling this is the point — see what "first-hour" approves.
 */
export type GateMode = "first-hour" | "total"

export interface DecideInput {
  proposal: Proposal
  quote: Quote
  /** Server-side ceiling. Atlas uses plan.gpu_sandbox_max_ttl_hours (24, all plans). */
  planTtlHours: number
  mode: GateMode
}

export type Verdict =
  | {
      ok: true
      /** May be less than proposed — the plan TTL clamps it. */
      approvedHours: number
      clampedFrom?: number
      costCents: number
      /** Free for BYOK; the wallet is never touched. */
      billed: boolean
    }
  | {
      ok: false
      /** Mirrors the shapes Atlas actually returns. */
      code: "insufficient_credit" | "unavailable" | "invalid"
      message: string
      /** The actionable part: what WOULD be approved. This is (b). */
      remedy?: { affordableHours: number; neededCents: number; availableCents: number }
    }

export function quoteTotal(rateCentsPerHour: number, hours: number): number {
  return Math.round(rateCentsPerHour * hours)
}

/**
 * THE decision. Runs server-side in the real design, which is the whole point:
 * a fork of the open-source client cannot reach it.
 */
export function decide(input: DecideInput): Verdict {
  const { proposal, quote, planTtlHours, mode } = input

  if (quote.funding === "unavailable")
    return { ok: false, code: "unavailable", message: `${proposal.sku} is not available on ${proposal.provider}.` }

  if (!Number.isFinite(proposal.hours) || proposal.hours <= 0)
    return { ok: false, code: "invalid", message: "Proposed duration must be a positive number of hours." }

  const approvedHours = Math.min(proposal.hours, planTtlHours)
  const clampedFrom = approvedHours < proposal.hours ? proposal.hours : undefined

  // BYOK runs on the user's own provider account. We never bill, so there is
  // nothing to gate on affordability.
  if (quote.funding === "byok")
    return { ok: true, approvedHours, clampedFrom, costCents: 0, billed: false }

  const total = quoteTotal(quote.rateCentsPerHour, approvedHours)
  const required = mode === "first-hour" ? quote.rateCentsPerHour : total

  if (required > quote.balanceCents) {
    const affordableHours = quote.rateCentsPerHour > 0 ? quote.balanceCents / quote.rateCentsPerHour : 0
    return {
      ok: false,
      code: "insufficient_credit",
      message: `Needs ${(required / 100).toFixed(2)} USD, wallet has ${(quote.balanceCents / 100).toFixed(2)} USD.`,
      remedy: {
        affordableHours: Math.floor(affordableHours * 10) / 10,
        neededCents: required,
        availableCents: quote.balanceCents,
      },
    }
  }

  return { ok: true, approvedHours, clampedFrom, costCents: total, billed: true }
}

// ── The running lease ───────────────────────────────────────────────────────

export type Phase =
  | "running"
  | "past-deadline"
  | "released"
  /** Nobody is left to call release. This is the financial exposure. */
  | "orphaned"

export interface Lease {
  id: string
  rateCentsPerHour: number
  approvedHours: number
  startedAtMs: number
  /** Absent when the server has no deadline column — i.e. Atlas as it stands. */
  expiresAtMs?: number
  phase: Phase
  /** Wall-clock cost so far. Atlas meters per second, never rounding up to an hour. */
  spentCents: number
  releaseAttempts: number
  note?: string
}

export interface World {
  /** Does the SERVER hold the deadline and enforce it in its sweep? */
  serverEnforcesDeadline: boolean
  /** Is our process still alive to run its own timer? */
  clientAlive: boolean
  /** Simulate release calls failing (provider flake, network, auth). */
  releaseFails: boolean
  /** Atlas's absolute backstop: plan.gpu_sandbox_max_ttl_hours. */
  planTtlHours: number
}

export function spend(lease: Lease, nowMs: number): number {
  const secs = Math.max(0, (nowMs - lease.startedAtMs) / 1000)
  return Math.round((lease.rateCentsPerHour * secs) / 3600)
}

export function overrunHours(lease: Lease, nowMs: number): number {
  const elapsed = (nowMs - lease.startedAtMs) / 3_600_000
  return Math.max(0, elapsed - lease.approvedHours)
}

/** What SHOULD happen next, given the world. Pure — the caller applies it. */
export type Action =
  | { kind: "none" }
  | { kind: "server-releases"; why: string }
  | { kind: "client-should-release"; why: string }
  | { kind: "nobody-will-release"; why: string; exposureCents: number }

export function evaluate(lease: Lease, nowMs: number, world: World): Action {
  if (lease.phase === "released" || lease.phase === "orphaned") return { kind: "none" }

  const elapsedHours = (nowMs - lease.startedAtMs) / 3_600_000
  const pastApproved = elapsedHours >= lease.approvedHours
  const pastPlanTtl = elapsedHours >= world.planTtlHours

  // The absolute backstop fires regardless of anything else.
  if (pastPlanTtl) return { kind: "server-releases", why: `plan TTL of ${world.planTtlHours}h reached` }

  if (!pastApproved) return { kind: "none" }

  // Past the approved duration. Who notices?
  if (world.serverEnforcesDeadline && lease.expiresAtMs !== undefined)
    return { kind: "server-releases", why: "server-side expires_at reached" }

  if (world.clientAlive) return { kind: "client-should-release", why: "client deadline timer fired" }

  // Nobody is watching. This is the case the design has to prevent.
  const untilBackstopH = Math.max(0, world.planTtlHours - elapsedHours)
  return {
    kind: "nobody-will-release",
    why: `no server deadline and the client is gone; billing until the ${world.planTtlHours}h backstop`,
    exposureCents: Math.round(lease.rateCentsPerHour * untilBackstopH),
  }
}

export type ReleaseResult =
  | { ok: true; already: boolean }
  | { ok: false; retryable: boolean; message: string }

/**
 * Release, modelling the outcomes Atlas actually returns. 409 (already
 * released) is SUCCESS for our purposes — the VM is gone either way.
 */
export function attemptRelease(lease: Lease, world: World): ReleaseResult {
  if (lease.phase === "released") return { ok: true, already: true }
  if (world.releaseFails)
    return { ok: false, retryable: true, message: "release failed (network/provider); VM may still be running" }
  return { ok: true, already: false }
}

/** Fail closed: never assume cleanup happened. Give up only after N tries. */
export const MAX_RELEASE_ATTEMPTS = 3

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`
  return `${h.toFixed(h < 10 ? 1 : 0)}h`
}
