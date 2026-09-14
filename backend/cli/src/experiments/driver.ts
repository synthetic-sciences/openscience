import { Experiments } from "."
import { Cost } from "@/harness/cost"
import { JobBroker } from "@/compute/job-broker"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import type { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import { KillCriteria } from "./kill"
import { StudyLedger } from "./ledger"
import { Tracker } from "./tracker"

/**
 * The operations half of a study. The agent owns the science; this loop owns
 * the clock: it follows each run's log for metrics, notices when a job ends,
 * applies kill criteria and budgets, and wakes the study's session with one
 * message that carries everything that happened since the last turn. Every
 * wake-up is an ordinary turn in the transcript, so the user can read why the
 * agent acted, and the state it acts on is the store, not a scraped pane.
 */
export namespace StudyDriver {
  const log = Log.create({ service: "study-driver" })

  export const TICK_MS = 3_000
  export const MAX_TURNS_PER_HOUR = 12
  /** How long a session may stay idle with free capacity and queued ideas
   * before the driver reminds it. */
  export const IDLE_NUDGE_MS = 4 * 60_000
  /** Keep the agent ahead of its slots: fewer queued ideas than this earns a
   * reminder to propose more, in the autoresearcherUI spirit. */
  export const BACKLOG_MIN = 3
  /** Consecutive non-improving runs before the driver asks for a change of kind. */
  export const STUCK_WINDOW = 4
  /** Completed runs between "step back" reviews. */
  export const STEP_BACK_EVERY = 6
  /** How long a live run may point at a job with no record before it is
   * marked failed. */
  export const MISSING_JOB_GRACE_MS = 2 * 60_000

  type Runtime = {
    followers: Map<string, Tracker.Follower>
    pending: string[]
    turnsAt: number[]
    lastNudgeAt: number
    nudgedRuns: number
    stuckReportedAt: number
    stepBackAt: number
    ticking: boolean
  }

  type Deps = {
    now?: () => number
    /** Test seam: the driver asks whether a session is idle before it prompts. */
    idle?: (sessionID: string) => boolean
    prompt?: (input: { sessionID: string; text: string }) => Promise<void>
    /** Model spend charged to the study's session so far, for cost budgets. */
    cost?: (sessionID: string) => Promise<number>
    job?: (jobID: string, sessionID: string) => Promise<JobBroker.Job | undefined>
    cancel?: (jobID: string, sessionID: string) => Promise<void>
    logPath?: (jobID: string, sessionID: string) => Promise<string>
  }

  const state = Instance.state(
    () => ({
      runtimes: new Map<string, Runtime>(),
      timer: undefined as ReturnType<typeof setInterval> | undefined,
      deps: {} as Deps,
    }),
    async (entry) => {
      if (entry.timer) clearInterval(entry.timer)
    },
  )

  function runtime(studyID: string): Runtime {
    const entry = state()
    const existing = entry.runtimes.get(studyID)
    if (existing) return existing
    const created: Runtime = {
      followers: new Map(),
      pending: [],
      turnsAt: [],
      lastNudgeAt: 0,
      nudgedRuns: -1,
      stuckReportedAt: 0,
      stepBackAt: 0,
      ticking: false,
    }
    entry.runtimes.set(studyID, created)
    return created
  }

  export function configure(deps: Deps) {
    state().deps = deps
  }

  /** Start the periodic tick for this project; safe to call repeatedly. */
  export function start() {
    const entry = state()
    if (entry.timer) return
    entry.timer = setInterval(() => void tickAll().catch((error) => log.warn("tick failed", { error })), TICK_MS)
  }

  /** On project start: if any study is live, begin ticking. */
  export async function resumeAll() {
    const studies = await Experiments.listStudies({ status: ["running", "paused"] })
    if (!studies.length) return
    start()
    for (const study of studies) {
      await Experiments.addEvent(study.id, "resumed", "server restarted; study clock resumed").catch(() => undefined)
    }
  }

  export function stop() {
    const entry = state()
    if (entry.timer) clearInterval(entry.timer)
    entry.timer = undefined
  }

  async function tickAll() {
    const studies = await Experiments.listStudies({ status: ["running", "paused"] })
    for (const study of studies) await tick(study.id).catch((error) => log.warn("study tick failed", { error }))
  }

  const deps = () => state().deps

  async function job(jobID: string, sessionID: string) {
    const custom = deps().job
    if (custom) return custom(jobID, sessionID)
    const { computeOptions } = await import("@/tool/compute-job")
    return JobBroker.get(jobID, await computeOptions(sessionID))
  }

  async function cancelJob(jobID: string, sessionID: string) {
    const custom = deps().cancel
    if (custom) return custom(jobID, sessionID)
    const { computeOptions } = await import("@/tool/compute-job")
    await JobBroker.cancel(jobID, await computeOptions(sessionID))
  }

  async function logPath(jobID: string, sessionID: string) {
    const custom = deps().logPath
    if (custom) return custom(jobID, sessionID)
    const { computeOptions } = await import("@/tool/compute-job")
    return JobBroker.logPath(jobID, await computeOptions(sessionID))
  }

  /** The study's model spend: the lead's own steps and every worker it
   * delegated to, since a delegating lead spends most of a study's money in
   * its workers. */
  async function sessionCost(sessionID: string) {
    const custom = deps().cost
    if (custom) return custom(sessionID)
    const messages = await Session.messages({ sessionID, limit: 2000 })
    const own = messages.reduce((total, message) => {
      const cost = message.info.role === "assistant" ? message.info.cost : 0
      return total + (typeof cost === "number" && Number.isFinite(cost) ? cost : 0)
    }, 0)
    return own + (await Cost.workers(sessionID))
  }

  function idle(sessionID: string) {
    const custom = deps().idle
    if (custom) return custom(sessionID)
    return SessionStatus.get(sessionID).type === "idle"
  }

  async function prompt(sessionID: string, text: string) {
    const custom = deps().prompt
    if (custom) return custom({ sessionID, text })
    // The study keeps the model, effort and delegation the user chose when
    // they started it, read from their last message in this session.
    const messages = await Session.messages({ sessionID, limit: 40 })
    const last = messages.findLast((message) => message.info.role === "user")?.info as MessageV2.User | undefined
    await SessionPrompt.submit({
      sessionID,
      agent: last?.agent ?? "research",
      model: last?.model,
      effort: last?.effort,
      delegation: last?.delegation,
      delegationSettings: last?.delegationSettings,
      parts: [{ type: "text", text }],
    })
  }

  const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"])

  function status(job: JobBroker.Job, run: Experiments.Run): Exclude<Experiments.RunStatus, "running"> {
    if (run.killReason) return "killed"
    if (job.status === "succeeded") return "finished"
    if (job.status === "cancelled") return "cancelled"
    return "failed"
  }

  /** One pass over a study: follow logs, settle finished runs, apply kill
   * criteria and budgets, then wake the session if there is news. */
  export async function tick(studyID: string) {
    const current = runtime(studyID)
    if (current.ticking) return
    current.ticking = true
    try {
      const study = await Experiments.getStudy(studyID)
      if (!study || (study.status !== "running" && study.status !== "paused")) return
      const now = deps().now?.() ?? Date.now()
      const running = await Experiments.listRuns({ studyID, status: "running" })
      const criteria = KillCriteria.parse(study.killCriteria)
      for (const run of running) {
        if (!run.jobID) continue
        const follower =
          current.followers.get(run.id) ??
          new Tracker.Follower(run.id, await logPath(run.jobID, study.sessionID), study.projectID)
        current.followers.set(run.id, follower)
        await follower.poll().catch((error) => log.warn("follow failed", { run: run.id, error }))
        const fresh = (await Experiments.getRun(run.id)) ?? run
        const windows = await recentWindows(fresh.id, criteria.rules, study.metric)
        const reason =
          criteria.rules.length && !fresh.killReason
            ? KillCriteria.check(
                criteria.rules,
                {
                  startedAt: fresh.startedAt ?? fresh.createdAt,
                  now,
                  lastStep: fresh.lastStep,
                  recent: (key, limit) => windows.get(`${key}\0${limit}`) ?? [],
                },
                study,
              )
            : undefined
        if (reason) {
          await cancelJob(run.jobID, study.sessionID).catch((error) => log.warn("kill failed", { run: run.id, error }))
          await Experiments.finishRun(fresh.id, "killed", { killReason: reason })
          await Experiments.addEvent(study.id, "killed", `${fresh.name} killed: ${reason}`, { runID: fresh.id })
          current.followers.delete(fresh.id)
          current.pending.push(describe(await Experiments.getRun(fresh.id), study, `killed: ${reason}`))
          continue
        }
        const info = await job(run.jobID, study.sessionID).catch(() => undefined)
        if (!info) {
          // A job record that stays missing was lost with its store; the run
          // cannot end on its own and would hold a slot for the study's life.
          const age = now - (fresh.startedAt ?? fresh.createdAt)
          if (age < MISSING_JOB_GRACE_MS) continue
          const lost = await Experiments.finishRun(fresh.id, "failed", {
            killReason: `job ${run.jobID} has no record; the run was marked failed after ${Math.round(age / 60_000)} min`,
          })
          current.followers.delete(fresh.id)
          if (lost) {
            await Experiments.addEvent(study.id, "failed", `${lost.name} failed: its job record is missing`, {
              runID: lost.id,
            })
            current.pending.push(describe(lost, study, "the compute job record is missing"))
          }
          continue
        }
        if (!terminal.has(info.status)) continue
        await follower.poll().catch(() => undefined)
        const settled = await Experiments.finishRun(fresh.id, status(info, fresh), {
          killReason: info.status === "failed" || info.status === "interrupted" ? info.error : undefined,
        })
        current.followers.delete(fresh.id)
        if (!settled) continue
        await Experiments.addEvent(
          study.id,
          settled.status,
          `${settled.name} ${settled.status}${settled.headline !== null ? ` (${study.metric} ${Experiments.format(settled.headline)})` : ""}`,
          { runID: settled.id },
        )
        current.pending.push(describe(settled, study, info.error ? `job ${info.status}: ${info.error}` : undefined))
      }

      await StudyLedger.render(study.id).catch((error) => log.warn("ledger render failed", { error }))
      if (study.status !== "running") return

      // Spend is only worth reading when a cost budget can act on it.
      const costed =
        study.budget.maxCostUSD !== undefined
          ? ((await Experiments.updateStudy(study.id, {
              costUSD: await sessionCost(study.sessionID).catch(() => study.costUSD),
            })) ?? study)
          : study
      const overrun = await budgetReached(costed, now)
      if (overrun) {
        await Experiments.updateStudy(study.id, { status: "paused" })
        await Experiments.addEvent(study.id, "budget", overrun)
        current.pending.push(
          `Budget reached: ${overrun}. Do not start new runs. Record any unrecorded result, write the study's conclusion with study conclude (what was learned, the best configuration, what remains open), and stop.`,
        )
        await wake(study, current, now, true)
        return
      }

      const stillRunning = await Experiments.listRuns({ studyID, status: "running" })
      const queued = await Experiments.listIdeas(study.id, { status: ["queued"] })
      const free = Math.max(0, study.concurrency - stillRunning.length)
      if (
        !current.pending.length &&
        free > 0 &&
        queued.length > 0 &&
        now - current.lastNudgeAt > IDLE_NUDGE_MS &&
        current.nudgedRuns !== stillRunning.length + queued.length &&
        idle(study.sessionID)
      ) {
        current.lastNudgeAt = now
        current.nudgedRuns = stillRunning.length + queued.length
        current.pending.push(
          `${free} of ${study.concurrency} slot${study.concurrency === 1 ? "" : "s"} free and ${queued.length} idea${queued.length === 1 ? "" : "s"} queued (next: ${queued[0]!.title}). Implement and start the next idea with study start, or drop it with a reason.`,
        )
      }
      // The loop is only as good as its backlog and its self-review. These
      // ride along with news that is already going out, never on their own.
      if (current.pending.length) {
        const done = (await Experiments.listRuns({ studyID, limit: 2000 }))
          .filter((run) => run.status !== "running")
          .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
        if (queued.length < BACKLOG_MIN && done.length) {
          current.pending.push(
            `Backlog is thin (${queued.length} queued). Before the next start, propose at least ${BACKLOG_MIN} ideas of different kinds (a different component, objective or data choice each), ranked by expected value, so a free slot never waits on an idea.`,
          )
        }
        if (done.length >= STUCK_WINDOW && done.length >= current.stuckReportedAt + STUCK_WINDOW) {
          const recent = done.slice(-STUCK_WINDOW)
          const fresh = (await Experiments.getStudy(study.id)) ?? study
          const ideas = await Experiments.listIdeas(study.id)
          // Progress is a run that became the best or was kept; a verdict may
          // not be recorded yet when the run has just settled.
          const progress = (run: Experiments.Run) =>
            run.id === fresh.bestRunID || ideas.find((idea) => idea.runID === run.id)?.status === "kept"
          if (!recent.some(progress)) {
            current.stuckReportedAt = done.length
            current.pending.push(
              `No progress in the last ${STUCK_WINDOW} runs. Change the kind of thing you vary (a different component, objective, data treatment or search strategy), not its magnitude, and reconsider the baseline's assumptions before proposing more of the same.`,
            )
          }
        }
        if (done.length > 0 && done.length % STEP_BACK_EVERY === 0 && done.length > current.stepBackAt) {
          current.stepBackAt = done.length
          current.pending.push(
            `Step back (${done.length} runs done): re-read the lessons, list the kinds of change tried so far and what each taught, check the queue for near-duplicates, and re-rank it. Then continue.`,
          )
        }
      }
      await wake(study, current, now, false)
    } finally {
      current.ticking = false
    }
  }

  /** The metric windows a run's kill rules will read, fetched once per tick
   * so the check itself stays synchronous. */
  async function recentWindows(runID: string, rules: KillCriteria.Rule[], metric: string) {
    const windows = new Map<string, Array<{ step: number; value: number }>>()
    for (const rule of rules) {
      if (rule.kind === "plateau") {
        const key = rule.key || metric
        windows.set(`${key}\0${rule.window * 4}`, await Experiments.recent(runID, key, rule.window * 4))
      }
      if (rule.kind === "threshold") {
        windows.set(`${rule.key}\0${rule.window}`, await Experiments.recent(runID, rule.key, rule.window))
      }
    }
    return windows
  }

  async function budgetReached(study: Experiments.Study, now: number): Promise<string | undefined> {
    const budget = study.budget
    const runs = await Experiments.listRuns({ studyID: study.id, limit: 2000 })
    const done = runs.filter((run) => run.status !== "running" && !Experiments.dispatchFailed(run))
    if (budget.maxRuns !== undefined && done.length >= budget.maxRuns)
      return `${done.length} runs completed (limit ${budget.maxRuns})`
    if (budget.maxHours !== undefined && now - study.createdAt >= budget.maxHours * 3_600_000) {
      return `${budget.maxHours} hour${budget.maxHours === 1 ? "" : "s"} elapsed`
    }
    if (budget.maxCostUSD !== undefined && study.costUSD >= budget.maxCostUSD) {
      return `model spend $${study.costUSD.toFixed(2)} reached the $${budget.maxCostUSD.toFixed(2)} limit`
    }
    if (budget.target !== undefined && study.bestRunID) {
      const best = runs.find((run) => run.id === study.bestRunID)
      if (best?.headline !== null && best?.headline !== undefined) {
        const hit = study.direction === "maximize" ? best.headline >= budget.target : best.headline <= budget.target
        if (hit)
          return `target ${study.metric} ${Experiments.format(budget.target)} reached by ${best.name} (${Experiments.format(best.headline)})`
      }
    }
    return
  }

  function describe(run: Experiments.Run | undefined, study: Experiments.Study, note?: string) {
    if (!run) return note ?? "A run ended."
    const headline =
      run.headline !== null ? `${study.metric} ${Experiments.format(run.headline)}` : `no ${study.metric} reported`
    const delta =
      run.baselineDelta !== null
        ? ` (${run.baselineDelta >= 0 ? "+" : ""}${Experiments.format(run.baselineDelta)} vs baseline, positive is better)`
        : ""
    const duration =
      run.endedAt && run.startedAt ? ` after ${Math.round((run.endedAt - run.startedAt) / 60_000)} min` : ""
    return `Run "${run.name}" (${run.id}) ${run.status}${duration}: ${headline}${delta}${note ? `. ${note}` : ""}. Read its logs or series if the number needs checking, then record the verdict with study record and queue or start the next idea.`
  }

  /** Send the pending news as one turn when the session is idle and the
   * hourly cap allows; urgent messages (budget) bypass the cap. */
  async function wake(study: Experiments.Study, current: Runtime, now: number, urgent: boolean) {
    if (!current.pending.length) return
    if (!idle(study.sessionID)) return
    current.turnsAt = current.turnsAt.filter((at) => now - at < 3_600_000)
    if (!urgent && current.turnsAt.length >= MAX_TURNS_PER_HOUR) return
    const lines = current.pending.splice(0)
    const text = [`Study update for "${study.name}":`, ...lines.map((line) => `- ${line}`)].join("\n")
    const sent = await prompt(study.sessionID, text)
      .then(() => true)
      .catch((error) => {
        log.warn("study wake failed", { study: study.id, error })
        current.pending.unshift(...lines)
        return false
      })
    // A turn counts only once it reached the session; a failed submit must
    // not spend the hourly cap or the study's turn tally.
    if (!sent) return
    current.turnsAt.push(now)
    // Any wake-up restarts the idle window: the agent needs time to act on it.
    current.lastNudgeAt = now
    await Experiments.updateStudy(study.id, { turns: study.turns + 1 })
    // A wake that the provider refused (an empty account, a rejected key)
    // would be refused again next tick; every retry is another failed turn in
    // the transcript. Pause instead and say why, so the study resumes once
    // the cause is fixed rather than knocking on a closed door every minute.
    const failure = await refusedTurn(study.sessionID)
    if (!failure) return
    current.pending.length = 0
    await Experiments.updateStudy(study.id, { status: "paused" })
    await Experiments.addEvent(
      study.id,
      "paused",
      `the session's turn failed (${failure}); fix the cause, then resume the study`,
    )
  }

  /** The provider's refusal, if the session's newest turn ended in one. */
  async function refusedTurn(sessionID: string) {
    const messages = await Session.messages({ sessionID, limit: 6 }).catch(() => [])
    const last = messages.findLast((message) => message.info.role === "assistant")
    if (!last || last.info.role !== "assistant" || !last.info.error) return
    const data = (last.info.error as { data?: { message?: unknown } }).data
    const message = typeof data?.message === "string" ? data.message : last.info.error.name
    return message.replace(/\s+/g, " ").slice(0, 200)
  }

  /** Called by the study tool when a run starts, so the follower begins
   * immediately instead of on the next tick. */
  export async function follow(run: Experiments.Run, study: Experiments.Study) {
    if (!run.jobID) return
    const current = runtime(study.id)
    current.followers.set(
      run.id,
      new Tracker.Follower(run.id, await logPath(run.jobID, study.sessionID), study.projectID),
    )
    current.nudgedRuns = -1
  }

  /** A directive from the user: stored on the study, then delivered as its
   * own wake-up, ahead of any cap. */
  export async function directive(studyID: string, text: string) {
    const added = await Experiments.addDirective(studyID, text)
    if (!added) return
    const current = runtime(studyID)
    current.pending.push(
      `Directive from the user: ${added.directive.text}. Treat it as a standing rule for the rest of the study; adjust the queue and your next run accordingly.`,
    )
    await wake(added.study, current, deps().now?.() ?? Date.now(), true)
    return added
  }

  /** Halt cancels every live run; pause only stops the wake-ups. */
  export async function halt(studyID: string, reason = "halted by the user") {
    const study = await Experiments.getStudy(studyID)
    if (!study) return
    const running = await Experiments.listRuns({ studyID, status: "running" })
    for (const run of running) {
      if (run.jobID)
        await cancelJob(run.jobID, study.sessionID).catch((error) => log.warn("halt cancel failed", { error }))
      await Experiments.finishRun(run.id, "cancelled", { killReason: reason })
    }
    await Experiments.updateStudy(studyID, { status: "halted" })
    await Experiments.addEvent(studyID, "halted", reason)
    runtime(studyID).pending.length = 0
    await StudyLedger.render(studyID).catch(() => undefined)
  }

  export async function pause(studyID: string) {
    await Experiments.updateStudy(studyID, { status: "paused" })
    await Experiments.addEvent(studyID, "paused", "paused by the user")
  }

  export async function resume(studyID: string) {
    const study = await Experiments.updateStudy(studyID, { status: "running" })
    await Experiments.addEvent(studyID, "resumed", "resumed by the user")
    const current = runtime(studyID)
    current.lastNudgeAt = 0
    current.nudgedRuns = -1
    return study
  }

  export async function conclude(studyID: string, conclusion: string) {
    await halt(studyID, "study concluded")
    const study = await Experiments.updateStudy(studyID, { status: "concluded", conclusion })
    await Experiments.addEvent(studyID, "concluded", conclusion.slice(0, 200))
    await StudyLedger.render(studyID).catch(() => undefined)
    return study
  }
}
