import z from "zod"
import { Decimal } from "decimal.js"
import { Storage } from "@/storage/storage"
import { Instance } from "@/project/instance"
import { Identifier } from "@/id/id"
import { Context } from "@/util/context"
import { SubagentDefaults } from "@synsci/util/subagents"

/** One transaction owns all grants and physical-call reservations for a root. */
export namespace SubagentBudget {
  const Amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  export const Settings = z.object({
    enabled: z.boolean().default(SubagentDefaults.enabled),
    model: z.string().min(1).optional(),
    usd: z.number().positive().max(1_000_000).optional(),
    tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    deadlineMs: z.number().int().positive().max(86_400_000).default(SubagentDefaults.deadlineMs),
    usdIncrease: z.number().positive().max(1_000_000).optional(),
    tokenIncrease: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  export type Settings = z.input<typeof Settings>
  export function settings(input: Settings = {}) {
    const value = Settings.parse(input)
    return {
      ...value,
      usd: value.usd ?? SubagentDefaults.usd,
      tokens: value.tokens ?? SubagentDefaults.tokens,
      usdIncrease: value.usdIncrease ?? SubagentDefaults.usdIncrease,
      tokenIncrease: value.tokenIncrease ?? SubagentDefaults.tokenIncrease,
    }
  }
  export const Unit = z.enum(["usd", "tokens"])
  export type Unit = z.infer<typeof Unit>
  export const Reason = z.enum([
    "budget_limit",
    "token_limit",
    "deadline",
    "route_changed",
    "pricing_unavailable",
    "setup_required",
    "budget_wrapup",
    "deadline_wrapup",
    "cancelled",
  ])
  export type Reason = z.infer<typeof Reason>
  export class LimitError extends DOMException {
    constructor(
      readonly reason: Reason,
      message = reason.replaceAll("_", " "),
    ) {
      super(message, "AbortError")
    }
  }
  /** A stale or conflicting allowance request; the caller should refresh and decide again. */
  export class ConflictError extends Error {}
  const Call = z.object({ amount: Amount, state: z.enum(["pending", "settled"]), consumed: Amount.optional() })
  export const Worker = z.object({
    sessionID: z.string(),
    parentSessionID: z.string(),
    rootSessionID: z.string(),
    assignmentID: z.string(),
    objective: z.string(),
    /** Short task label from the Task call; absent on records saved before it was kept. */
    description: z.string().optional(),
    expectedOutput: z.string(),
    model: z.object({ providerID: z.string(), modelID: z.string() }),
    variant: z.string().optional(),
    route: z.string(),
    unit: Unit,
    limit: Amount,
    spent: Amount,
    active: z.boolean(),
    acceptedAt: z.number().optional(),
    deadline: z.number(),
    stopReason: Reason.optional(),
    wrapup: z.boolean().optional(),
    wrapupReason: z.enum(["budget_wrapup", "deadline_wrapup"]).optional(),
    handoffCallID: z.string().optional(),
    handoff: z.string().optional(),
    outcome: z.enum(["completed", "partial", "error"]).optional(),
    reportReason: z.string().optional(),
    agent: z.string().optional(),
    deleted: z.boolean().optional(),
    calls: z.record(z.string(), Call),
  })
  export type Worker = z.infer<typeof Worker>
  export const Pool = z.object({
    enabled: z.boolean().default(true),
    version: z.literal(1),
    projectID: z.string(),
    rootSessionID: z.string(),
    revision: Amount,
    limits: z.object({ usd: Amount, tokens: Amount }),
    workers: z.record(z.string(), Worker),
    approvals: z.record(z.string(), z.object({ unit: Unit, amount: Amount, revision: Amount })),
    continuations: z
      .record(
        z.string(),
        z.object({
          childID: z.string(),
          userID: z.string(),
          messageID: z.string(),
          partID: z.string(),
          callID: z.string(),
          amount: Amount,
          completed: z.boolean(),
        }),
      )
      .default({}),
  })
  export type Pool = z.infer<typeof Pool>
  export const Snapshot = Pool.extend({
    available: z.object({ usd: Amount, tokens: Amount }),
    continuationCapacity: z.record(z.string(), z.object({ available: Amount, ancestorLimited: z.boolean() })),
  })
  const running = new Map<string, { parentID: string; controller: AbortController }>()

  function halt(worker: Worker, reason: Reason) {
    if (!worker.stopReason || worker.stopReason === "budget_wrapup" || worker.stopReason === "deadline_wrapup")
      worker.stopReason = reason
  }

  export async function watch(worker: Worker, signal: AbortSignal) {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    running.set(worker.sessionID, { parentID: worker.parentSessionID, controller })
    const timer = setTimeout(
      () => {
        void stop(worker.sessionID, "deadline")
          .finally(() => controller.abort(new LimitError("deadline")))
          .catch(() => undefined)
      },
      Math.max(0, worker.deadline - Date.now()),
    )
    const poll = setInterval(() => {
      void read(worker.sessionID)
        .then((state) => {
          if (state?.worker.stopReason === "cancelled") controller.abort(new LimitError("cancelled"))
        })
        .catch(() => controller.abort(new Error("Subagent allowance could not be read")))
    }, 2500)
    return {
      signal: controller.signal,
      async [Symbol.asyncDispose]() {
        clearTimeout(timer)
        clearInterval(poll)
        signal.removeEventListener("abort", abort)
        if (controller.signal.reason instanceof LimitError)
          await stop(worker.sessionID, controller.signal.reason.reason)
        // A provider stream can time out before this watcher's timer persists its stop.
        else if (worker.deadline <= Date.now()) await stop(worker.sessionID, "deadline")
        if (running.get(worker.sessionID)?.controller === controller) running.delete(worker.sessionID)
        await release(worker.sessionID)
      },
    }
  }

  export function cancel(sessionID: string) {
    running.get(sessionID)?.controller.abort(new LimitError("cancelled"))
    cancelChildren(sessionID)
  }

  export function cancelChildren(sessionID: string) {
    const stopping = new Set<string>()
    for (const [childID, entry] of running) {
      if (entry.parentID !== sessionID) continue
      stopping.add(childID)
      entry.controller.abort(new LimitError("cancelled"))
      cancelChildren(childID)
    }
    void (async () => {
      const bound = await root(sessionID)
      const id = bound ?? sessionID
      if (!(await inspect(id))) return
      await mutate(id, (current) => {
        const pool = current!
        const descendant = (w: Worker): boolean =>
          w.parentSessionID === sessionID ||
          (!!pool.workers[w.parentSessionID] && descendant(pool.workers[w.parentSessionID]))
        for (const w of Object.values(pool.workers))
          if ((w.active || stopping.has(w.sessionID)) && descendant(w)) halt(w, "cancelled")
        return { pool, result: undefined }
      })
    })().catch(() => undefined)
  }

  export function summary(pool: Pool, worker: Worker) {
    return {
      unit: worker.unit,
      limit: worker.limit,
      spent: worker.spent,
      pending: pending(worker),
      remaining: available(pool, worker.unit, worker.sessionID),
      deadline: worker.deadline,
      stopReason: worker.stopReason,
    }
  }

  export function dollars(value: number | string) {
    const amount = new Decimal(value).mul(1_000_000_000).ceil().toNumber()
    return Amount.parse(amount)
  }
  export function usd(amount: number) {
    return new Decimal(amount).div(1_000_000_000).toNumber()
  }
  const pending = (worker: Worker) =>
    Object.values(worker.calls).reduce((sum, call) => sum + (call.state === "pending" ? call.amount : 0), 0)
  function ancestor(pool: Pool, id: string, unit: Unit): Worker | undefined {
    const w = pool.workers[id]
    return w ? (w.unit === unit ? w : ancestor(pool, w.parentSessionID, unit)) : undefined
  }
  const children = (pool: Pool, id: string) =>
    Object.values(pool.workers).filter((w) => ancestor(pool, w.parentSessionID, w.unit)?.sessionID === id)
  function family(pool: Pool, id: string): Worker[] {
    return [pool.workers[id], ...children(pool, id).flatMap((w) => family(pool, w.sessionID))]
  }
  export function consumed(pool: Pool, id: string) {
    return family(pool, id).reduce((sum, w) => sum + w.spent, 0)
  }
  function held(pool: Pool, worker: Worker): number {
    return worker.active
      ? Math.max(
          family(pool, worker.sessionID).reduce((sum, w) => sum + pending(w), 0),
          worker.limit - consumed(pool, worker.sessionID),
        )
      : pending(worker) + children(pool, worker.sessionID).reduce((sum, w) => sum + held(pool, w), 0)
  }
  export function available(pool: Pool, unit: Unit, sessionID?: string): number {
    if (sessionID) {
      const w = pool.workers[sessionID]
      return Math.max(
        0,
        w.limit -
          consumed(pool, sessionID) -
          pending(w) -
          children(pool, sessionID).reduce((sum, child) => sum + held(pool, child), 0),
      )
    }
    const workers = Object.values(pool.workers).filter((w) => w.unit === unit)
    return Math.max(
      0,
      pool.limits[unit] -
        workers.reduce((sum, w) => sum + w.spent, 0) -
        workers.filter((w) => !ancestor(pool, w.parentSessionID, unit)).reduce((sum, w) => sum + held(pool, w), 0),
    )
  }
  /** Grants reserve a share; actual spend and unknown calls also bound every ancestor. */
  export function spendable(pool: Pool, sessionID: string) {
    const w = pool.workers[sessionID]
    const capacity = (workers: Worker[], limit: number) =>
      limit - workers.reduce((sum, child) => sum + child.spent + pending(child), 0)
    const ancestors = (worker: Worker): number[] => {
      const parent = ancestor(pool, worker.parentSessionID, worker.unit)
      return parent ? [capacity(family(pool, parent.sessionID), parent.limit), ...ancestors(parent)] : []
    }
    return Math.max(
      0,
      Math.min(
        available(pool, w.unit, sessionID),
        capacity(
          Object.values(pool.workers).filter((child) => child.unit === w.unit),
          pool.limits[w.unit],
        ),
        ...ancestors(w),
      ),
    )
  }
  function capacity(pool: Pool, unit: Unit, parentSessionID: string): { available: number; ancestorLimited: boolean } {
    const parent = ancestor(pool, parentSessionID, unit)
    if (!parent) return { available: available(pool, unit), ancestorLimited: false }
    const prior = capacity(pool, unit, parent.parentSessionID)
    const free = available(pool, unit, parent.sessionID)
    return {
      // Inactive ancestors have returned their unused grants to the outer pool.
      available: Math.min(free, parent.active ? spendable(pool, parent.sessionID) : prior.available),
      // An active parent's held grant is the binding limit; only an inactive one inherits its ancestors' limit.
      ancestorLimited: free === 0 || (!parent.active && prior.ancestorLimited),
    }
  }
  async function root(sessionID: string) {
    const projectID = await Promise.resolve()
      .then(() => Instance.project.id)
      .catch((error) => {
        if (error instanceof Context.NotFound) return undefined
        throw error
      })
    if (!projectID) return
    const binding = await Storage.read<{ rootSessionID: string }>(["subagent_binding", projectID, sessionID]).catch(
      (error) => {
        if (Storage.NotFoundError.isInstance(error)) return undefined
        throw error
      },
    )
    return binding?.rootSessionID
  }
  export async function inspect(rootSessionID: string): Promise<Pool | undefined> {
    const value = await Storage.read<unknown>(["subagent_budget", Instance.project.id, rootSessionID]).catch(
      (error) => {
        if (Storage.NotFoundError.isInstance(error)) return undefined
        throw error
      },
    )
    return value === undefined ? undefined : Pool.parse(value)
  }
  export async function read(sessionID: string) {
    const id = await root(sessionID)
    const pool = id ? await inspect(id) : undefined
    if (id && !pool) throw new LimitError("cancelled", "The subagent session budget was deleted")
    const worker = pool?.workers[sessionID]
    return pool && worker ? { pool, worker } : undefined
  }
  async function mutate<T>(rootSessionID: string, fn: (pool?: Pool) => { pool: Pool; result: T; binding?: string }) {
    const projectID = Instance.project.id
    const database = await Storage.research()
    return database.transaction((db) => {
      const current = db
        .query<{ data: string }, [string, string]>("SELECT data FROM subagent_budget WHERE project_id=? AND id=?")
        .get(projectID, rootSessionID)
      if (
        !current &&
        db.query("SELECT 1 FROM subagent_binding WHERE project_id=? AND id=?").get(projectID, rootSessionID)
      )
        throw new LimitError("cancelled", "The subagent session budget was deleted")
      const before = current ? JSON.stringify(Pool.parse(JSON.parse(current.data))) : undefined
      const value = fn(current ? Pool.parse(JSON.parse(current.data)) : undefined)
      if (value.binding) {
        const binding = db
          .query<{ data: string }, [string, string]>("SELECT data FROM subagent_binding WHERE project_id=? AND id=?")
          .get(projectID, value.binding)
        if (binding && JSON.parse(binding.data).rootSessionID !== rootSessionID)
          throw new Error("Subagent root cannot change")
      }
      if (before === JSON.stringify(value.pool)) return value.result
      value.pool.revision++
      db.query(
        "INSERT INTO subagent_budget(project_id,id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      ).run(projectID, rootSessionID, JSON.stringify(value.pool), Date.now())
      if (value.binding)
        db.query(
          "INSERT INTO subagent_binding(project_id,id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
        ).run(projectID, value.binding, JSON.stringify({ rootSessionID }), Date.now())
      return value.result
    })
  }
  export async function snapshot(sessionID: string) {
    const state = await read(sessionID)
    const pool = state?.pool ?? (await inspect(sessionID))
    return pool
      ? {
          ...pool,
          available: { usd: available(pool, "usd"), tokens: available(pool, "tokens") },
          continuationCapacity: Object.fromEntries(
            Object.values(pool.workers).map((worker) => [
              worker.sessionID,
              capacity(pool, worker.unit, worker.parentSessionID),
            ]),
          ),
        }
      : null
  }
  export async function remove(sessionID: string) {
    running.get(sessionID)?.controller.abort(new LimitError("cancelled"))
    cancelChildren(sessionID)
    const id = await root(sessionID)
    if (!id) {
      if (await inspect(sessionID)) {
        const database = await Storage.research()
        database.transaction((db) => {
          db.query(
            "INSERT INTO subagent_binding(project_id,id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
          ).run(Instance.project.id, sessionID, JSON.stringify({ rootSessionID: sessionID }), Date.now())
          db.query("DELETE FROM subagent_budget WHERE project_id=? AND id=?").run(Instance.project.id, sessionID)
        })
      }
      return
    }
    if (!(await inspect(id))) return
    await mutate(id, (current) => {
      const pool = current!
      const w = pool.workers[sessionID]
      if (w) {
        w.active = false
        w.deleted = true
        w.objective = ""
        w.description = undefined
        w.expectedOutput = ""
        w.handoff = undefined
        w.stopReason = "cancelled"
      }
      return { pool, result: undefined }
    })
  }
  function create(rootSessionID: string, settings: Settings, enabled: boolean): Pool {
    return {
      enabled,
      version: 1,
      projectID: Instance.project.id,
      rootSessionID,
      revision: 0,
      limits: { usd: enabled ? dollars(settings.usd ?? 0) : 0, tokens: enabled ? (settings.tokens ?? 0) : 0 },
      workers: {},
      approvals: {},
      continuations: {},
    }
  }
  /** Saving defaults must not change an admitted conversation's spending policy. */
  export async function initialize(rootSessionID: string, input: Settings) {
    const value = settings(input)
    return mutate(rootSessionID, (current) => {
      const pool = current ?? create(rootSessionID, value, value.enabled)
      return { pool, result: pool.enabled }
    })
  }
  export async function open(input: {
    rootSessionID: string
    parentSessionID: string
    sessionID: string
    assignmentID: string
    objective: string
    description?: string
    expectedOutput: string
    model: Worker["model"]
    variant?: string
    route: string
    unit: Unit
    allocation?: number
    settings: Settings
    acceptedAt?: number
    deadline?: number
    agent?: string
  }): Promise<Worker> {
    const settings = Settings.parse(input.settings)
    const existing = await inspect(input.rootSessionID)
    const limit =
      existing?.limits[input.unit] ?? (input.unit === "usd" ? dollars(settings.usd ?? 0) : (settings.tokens ?? 0))
    if (!limit)
      throw new LimitError(
        "setup_required",
        `This conversation has no ${input.unit === "usd" ? "USD" : "token"} budget for subagents. Set a ${input.unit === "usd" ? "USD" : "token"} limit under Settings → General → Bounded runs, then start the worker again.`,
      )
    return mutate(input.rootSessionID, (current) => {
      const pool = current ?? create(input.rootSessionID, settings, true)
      if (!pool.enabled) throw new LimitError("setup_required", "Bounded runs are off for this conversation")
      const prior = pool.workers[input.sessionID]
      if (prior?.deleted) throw new LimitError("cancelled", "The subagent session was deleted")
      if (prior?.parentSessionID !== undefined && prior.parentSessionID !== input.parentSessionID)
        throw new Error("Subagent parent changed")
      if (prior?.assignmentID === input.assignmentID) return { pool, result: prior }
      if (prior?.active) throw new Error("Subagent is still running; wait for its current assignment to stop")
      if (prior && (prior.unit !== input.unit || prior.route !== input.route))
        throw new LimitError("route_changed", "Continue this child on its original access route or start a new child.")
      const free = capacity(pool, input.unit, input.parentSessionID).available
      const amount =
        input.allocation === undefined ? Math.min(Math.floor(limit / 4), free) : Amount.parse(input.allocation)
      if (amount <= 0 || amount > free)
        throw new LimitError(
          input.unit === "usd" ? "budget_limit" : "token_limit",
          "Subagent allowance limit reached; allocate remaining funds or ask the user to increase the limit.",
        )
      const worker = Worker.parse({
        ...input,
        // The objective labels the child; a follow-up prompt continues that task, it does not rename it.
        objective: prior?.objective || input.objective,
        description: prior?.description || input.description,
        limit:
          (prior
            ? consumed(pool, prior.sessionID) +
              pending(prior) +
              children(pool, prior.sessionID).reduce((sum, w) => sum + held(pool, w), 0)
            : 0) + amount,
        spent: prior?.spent ?? 0,
        calls: prior?.calls ?? {},
        active: true,
        acceptedAt: input.acceptedAt ?? Date.now(),
        deadline: input.deadline ?? Date.now() + settings.deadlineMs,
      })
      pool.workers[input.sessionID] = worker
      return { pool, result: worker, binding: input.sessionID }
    })
  }
  export async function reserve(sessionID: string, callID: string, amount: number, handoff = false, internal = false) {
    const id = await root(sessionID)
    if (!id) return
    const failure = await mutate<Reason | undefined>(id, (current) => {
      const pool = current!
      const w = pool.workers[sessionID]
      if (w.calls[callID]) return { pool, result: undefined }
      if (w.stopReason === "cancelled") return { pool, result: "cancelled" }
      const reason =
        w.deadline <= Date.now()
          ? "deadline"
          : !w.active || amount > spendable(pool, sessionID)
            ? w.unit === "usd"
              ? "budget_limit"
              : "token_limit"
            : undefined
      // An internal call that loses to the worker's own in-flight reservation is skipped, not fatal.
      if (reason && internal && w.active && reason !== "deadline") return { pool, result: reason }
      if (reason) {
        halt(w, reason)
        return { pool, result: w.stopReason }
      }
      if (handoff && w.handoffCallID && w.handoffCallID !== callID) {
        halt(w, w.wrapupReason ?? "budget_wrapup")
        return { pool, result: w.stopReason }
      }
      w.calls[callID] = { amount: Amount.parse(amount), state: "pending" }
      if (handoff) w.handoffCallID = callID
      return { pool, result: undefined }
    })
    if (failure) throw new LimitError(failure)
  }
  export async function settle(sessionID: string, callID: string, amount?: number) {
    const id = await root(sessionID)
    if (!id) return
    await mutate(id, (current) => {
      const pool = current!
      const w = pool.workers[sessionID]
      const call = w.calls[callID]
      if (!call || call.state === "settled" || amount === undefined) return { pool, result: undefined }
      call.consumed = Amount.parse(amount)
      call.state = "settled"
      w.spent += amount
      if (consumed(pool, sessionID) >= w.limit) halt(w, w.unit === "usd" ? "budget_limit" : "token_limit")
      return { pool, result: undefined }
    })
  }
  export async function release(sessionID: string, assignmentID?: string) {
    const id = await root(sessionID)
    if (!id) return
    await mutate(id, (current) => {
      const pool = current!
      if (!assignmentID || pool.workers[sessionID].assignmentID === assignmentID) pool.workers[sessionID].active = false
      return { pool, result: undefined }
    })
  }
  export async function stop(sessionID: string, reason: Reason) {
    const id = await root(sessionID)
    if (!id) return
    await mutate(id, (current) => {
      const pool = current!
      halt(pool.workers[sessionID], reason)
      return { pool, result: undefined }
    })
  }
  export async function wrapup(sessionID: string, reason: "budget_wrapup" | "deadline_wrapup" = "budget_wrapup") {
    const id = await root(sessionID)
    if (!id) return
    await mutate(id, (current) => {
      const pool = current!
      const worker = pool.workers[sessionID]
      worker.wrapupReason ??= worker.wrapup ? "budget_wrapup" : reason
      worker.wrapup = true
      return { pool, result: undefined }
    })
  }
  export async function report(
    sessionID: string,
    input: { handoff: string; outcome: "completed" | "partial" | "error"; reason: string },
  ) {
    const id = await root(sessionID)
    if (!id) return
    await mutate(id, (current) => {
      const pool = current!
      const w = pool.workers[sessionID]
      if (w.deleted) return { pool, result: undefined }
      w.handoff = input.handoff.slice(0, 4000)
      w.outcome = input.outcome
      w.reportReason = input.reason
      if (input.reason === "cancelled") w.stopReason ??= "cancelled"
      return { pool, result: undefined }
    })
  }
  /** The smallest continuation worth starting: the cost of the worker's largest settled call. */
  export function minimum(worker: Worker) {
    return Object.values(worker.calls).reduce((max, call) => Math.max(max, call.consumed ?? 0), 0)
  }
  export async function continuation(rootSessionID: string, childID: string, key: string) {
    return mutate(rootSessionID, (current) => {
      if (!current) throw new Error("Subagent allowance not found")
      const pool = current
      const prior = pool.continuations[key]
      if (prior) {
        if (prior.childID !== childID) throw new Error("Continuation key conflict")
        return { pool, result: prior }
      }
      const worker = pool.workers[childID]
      if (!worker || worker.deleted) throw new Error("Subagent not found")
      if (worker.active) throw new Error("Subagent is still running")
      const amount = capacity(pool, worker.unit, worker.parentSessionID).available
      if (!amount) throw new Error("Increase the subagent allowance before continuing")
      // A continuation that cannot afford one more call like the last would stop at once.
      const needed = minimum(worker)
      if (amount < needed)
        throw new Error(
          `Only ${worker.unit === "usd" ? `USD ${usd(amount)}` : `${amount} tokens`} is available; this subagent's last model call used ${worker.unit === "usd" ? `USD ${usd(needed)}` : `${needed} tokens`}. Increase the subagent allowance before continuing.`,
        )
      const operation = {
        childID,
        userID: Identifier.ascending("message"),
        messageID: Identifier.ascending("message"),
        partID: Identifier.ascending("part"),
        callID: crypto.randomUUID(),
        amount,
        completed: false,
      }
      pool.continuations[key] = operation
      return { pool, result: operation }
    })
  }
  export async function finishContinuation(rootSessionID: string, key: string) {
    return mutate(rootSessionID, (current) => {
      const pool = current!
      pool.continuations[key].completed = true
      return { pool, result: undefined }
    })
  }
  export async function increase(
    rootSessionID: string,
    input: { unit: Unit; amount: number; revision: number; key: string },
  ) {
    return mutate(rootSessionID, (current) => {
      if (!current) throw new Error("Subagent allowance not found")
      const pool = current
      if (!pool.enabled) throw new ConflictError("Bounded runs are off for this conversation")
      const previous = pool.approvals[input.key]
      if (previous) {
        if (previous.unit !== input.unit || previous.amount !== input.amount || previous.revision !== input.revision)
          throw new ConflictError("Approval key conflict")
        return { pool, result: pool }
      }
      if (pool.revision !== input.revision)
        throw new ConflictError("Subagent allowance revision changed; refresh before approving")
      if (input.amount <= 0) throw new Error("Increase must be positive")
      pool.limits[input.unit] = Amount.parse(pool.limits[input.unit] + Amount.parse(input.amount))
      pool.approvals[input.key] = { unit: input.unit, amount: input.amount, revision: input.revision }
      return { pool, result: pool }
    })
  }
}
