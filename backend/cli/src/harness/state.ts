import type { Config } from "@/config/config"

/**
 * Per-session facts the harness units share: what the loop told them about
 * the session (delegation, headless policy, deadline) and what they learned
 * (deliverables, spend). Keyed by session id, cleared when the session ends.
 * A test can replace the clock and the cgroup root.
 */
export namespace HarnessState {
  export type Unit =
    | "headless-policy"
    | "redirect"
    | "deliverables"
    | "acceptance"
    | "unattended"
    | "review"
    | "budget"
    | "cost"
    | "durable-jobs"
    | "workers"

  export const UNITS: readonly Unit[] = [
    "headless-policy",
    "redirect",
    "deliverables",
    "acceptance",
    "unattended",
    "review",
    "budget",
    "cost",
    "durable-jobs",
    "workers",
  ]

  export type Session = {
    delegation?: boolean
    continueOnDeny?: boolean
    /** Epoch ms when the current work started (first prompt seen). */
    startedAt?: number
    deadline?: number
    deliverables: string[]
    /** The header the request states for a CSV/TSV deliverable, by path. */
    deliverableHeaders?: Record<string, string>
    deliverableRounds: number
    /** The last mechanical check still found problems. */
    deliverablesFailing: boolean
    /** The verification contract the first request states: commands that
     * must pass, tokens banned under a path. */
    acceptance: { commands: { command: string; cwd?: string }[]; banned: { tokens: string[]; scope: string }[] }
    acceptanceRounds: number
    acceptanceFailing: boolean
    /** Times the unattended-run continuation has answered a final question. */
    unattendedRounds: number
    /** Times the review of a written report has sent the lead back with gaps. */
    reviewRounds: number
    /** The last review's list, for the second read to check against. */
    reviewGaps?: string[]
    budgetNudged: boolean
    guardTrips: number
    budgetReminders: Set<50 | 85>
    /** `seeded`: the stored transcript has been summed once, so a process
     * that restarted mid-session does not start the count again at zero. */
    spend: { cost: number; tokens: number; workers: number; ceilingNoted: boolean; seeded?: boolean }
    /** Per status component (the units' reminders, the study's state), the
     * key last appended to the transcript, so the same state is not appended
     * again on the next step. */
    statusDelivered?: Record<string, string>
    /** The tool-availability notice last appended, for the same reason. */
    toolNoticeDelivered?: string
  }

  const sessions = new Map<string, Session>()

  export const clock = { now: () => Date.now() }

  export const cgroup = { root: "/sys/fs/cgroup" }

  export function get(sessionID: string): Session {
    const current = sessions.get(sessionID)
    if (current) return current
    const created: Session = {
      deliverables: [],
      deliverableRounds: 0,
      deliverablesFailing: false,
      acceptance: { commands: [], banned: [] },
      acceptanceRounds: 0,
      acceptanceFailing: false,
      unattendedRounds: 0,
      reviewRounds: 0,
      budgetNudged: false,
      guardTrips: 0,
      budgetReminders: new Set(),
      spend: { cost: 0, tokens: 0, workers: 0, ceilingNoted: false },
    }
    sessions.set(sessionID, created)
    return created
  }

  export function clear(sessionID: string) {
    sessions.delete(sessionID)
  }

  export function reset() {
    sessions.clear()
    clock.now = () => Date.now()
    cgroup.root = "/sys/fs/cgroup"
  }

  /** Whether a unit is on; every unit defaults to on. */
  export function enabled(config: Config.Info, unit: Unit) {
    const value = config.harness?.[unit]
    return value !== false
  }

  export function costCeiling(config: Config.Info) {
    const value = config.harness?.cost
    return typeof value === "object" ? value.max_usd : undefined
  }

  /** A headless run registers its root session: denied tool calls continue
   * the loop instead of ending it. */
  export function headless(sessionID: string, input: { continueOnDeny: boolean }) {
    get(sessionID).continueOnDeny = input.continueOnDeny
  }

  export function continueOnDeny(config: Config.Info, sessionID: string) {
    if (!enabled(config, "headless-policy")) return false
    return get(sessionID).continueOnDeny === true
  }

  /** The loop records whether this session may delegate this turn so tool
   * hints (truncation) can offer Task only when it is actually available. */
  export function delegation(sessionID: string, enabled: boolean) {
    get(sessionID).delegation = enabled
  }

  export function delegates(config: Config.Info, sessionID: string | undefined) {
    if (!sessionID) return true
    if (!enabled(config, "durable-jobs")) return true
    return get(sessionID).delegation !== false
  }
}
