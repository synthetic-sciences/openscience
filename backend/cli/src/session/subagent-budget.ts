import z from "zod"
import { Decimal } from "decimal.js"
import { Storage } from "@/storage/storage"
import { Instance } from "@/project/instance"

/** One transaction owns all grants and physical-call reservations for a root. */
export namespace SubagentBudget {
  const Amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  export const Settings = z.object({
    model: z.string().min(1).optional(),
    usd: z.number().positive().max(1_000_000).optional(),
    tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    deadlineMs: z.number().int().positive().max(86_400_000).default(600_000),
    usdIncrease: z.number().positive().max(1_000_000).optional(),
    tokenIncrease: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  export type Settings = z.input<typeof Settings>
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
  const Call = z.object({ amount: Amount, state: z.enum(["pending", "settled"]), consumed: Amount.optional() })
  export const Worker = z.object({
    sessionID: z.string(),
    parentSessionID: z.string(),
    rootSessionID: z.string(),
    assignmentID: z.string(),
    objective: z.string(),
    expectedOutput: z.string(),
    model: z.object({ providerID: z.string(), modelID: z.string() }),
    route: z.string(),
    unit: Unit,
    limit: Amount,
    spent: Amount,
    active: z.boolean(),
    deadline: z.number(),
    stopReason: Reason.optional(),
    calls: z.record(z.string(), Call),
  })
  export type Worker = z.infer<typeof Worker>
  export const Pool = z.object({
    version: z.literal(1),
    projectID: z.string(),
    rootSessionID: z.string(),
    revision: Amount,
    limits: z.object({ usd: Amount, tokens: Amount }),
    workers: z.record(z.string(), Worker),
    approvals: z.record(z.string(), z.object({ unit: Unit, amount: Amount, revision: Amount })),
  })
  export type Pool = z.infer<typeof Pool>

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
  function consumed(pool: Pool, id: string) {
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
  async function root(sessionID: string) {
    const binding = await Storage.read<{ rootSessionID: string }>([
      "subagent_binding",
      Instance.project.id,
      sessionID,
    ]).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
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
  export async function open(input: {
    rootSessionID: string
    parentSessionID: string
    sessionID: string
    assignmentID: string
    objective: string
    expectedOutput: string
    model: Worker["model"]
    route: string
    unit: Unit
    allocation?: number
    settings: Settings
    deadline?: number
  }): Promise<Worker> {
    const settings = Settings.parse(input.settings)
    const limit = input.unit === "usd" ? dollars(settings.usd ?? 0) : (settings.tokens ?? 0)
    if (!limit)
      throw new LimitError(
        "setup_required",
        `Configure the ${input.unit === "usd" ? "paid USD" : "subscription token"} subagent allowance in Settings before starting this worker.`,
      )
    return mutate(input.rootSessionID, (current) => {
      const pool: Pool = current ?? {
        version: 1,
        projectID: Instance.project.id,
        rootSessionID: input.rootSessionID,
        revision: 0,
        limits: { usd: dollars(settings.usd ?? 0), tokens: settings.tokens ?? 0 },
        workers: {},
        approvals: {},
      }
      const prior = pool.workers[input.sessionID]
      if (prior?.parentSessionID !== undefined && prior.parentSessionID !== input.parentSessionID)
        throw new Error("Subagent parent changed")
      if (prior?.assignmentID === input.assignmentID) return { pool, result: prior }
      if (prior && (prior.unit !== input.unit || prior.route !== input.route))
        throw new LimitError("route_changed", "Continue this child on its original access route or start a new child.")
      const parent = ancestor(pool, input.parentSessionID, input.unit)
      const free = available(pool, input.unit, parent?.sessionID)
      const amount =
        input.allocation === undefined ? Math.min(Math.floor(limit / 4), free) : Amount.parse(input.allocation)
      if (amount <= 0 || amount > free)
        throw new LimitError(
          input.unit === "usd" ? "budget_limit" : "token_limit",
          "Subagent allowance limit reached; allocate remaining funds or ask the user to increase the limit.",
        )
      const worker: Worker = {
        ...input,
        limit: (prior ? consumed(pool, prior.sessionID) + pending(prior) : 0) + amount,
        spent: prior?.spent ?? 0,
        calls: prior?.calls ?? {},
        active: true,
        deadline: input.deadline ?? Date.now() + settings.deadlineMs,
      }
      pool.workers[input.sessionID] = worker
      return { pool, result: worker, binding: input.sessionID }
    })
  }
  export async function reserve(sessionID: string, callID: string, amount: number) {
    const id = await root(sessionID)
    if (!id) return
    const failure = await mutate<Reason | undefined>(id, (current) => {
      const pool = current!
      const w = pool.workers[sessionID]
      if (w.calls[callID]) return { pool, result: undefined }
      const reason =
        w.deadline <= Date.now()
          ? "deadline"
          : !w.active || amount > available(pool, w.unit, sessionID)
            ? w.unit === "usd"
              ? "budget_limit"
              : "token_limit"
            : undefined
      if (reason) {
        w.stopReason = reason
        return { pool, result: reason }
      }
      w.calls[callID] = { amount: Amount.parse(amount), state: "pending" }
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
      if (consumed(pool, sessionID) >= w.limit) w.stopReason = w.unit === "usd" ? "budget_limit" : "token_limit"
      return { pool, result: undefined }
    })
  }
  export async function release(sessionID: string) {
    const id = await root(sessionID)
    if (!id) return
    await mutate(id, (current) => {
      const pool = current!
      pool.workers[sessionID].active = false
      return { pool, result: undefined }
    })
  }
  export async function stop(sessionID: string, reason: Reason) {
    const id = await root(sessionID)
    if (!id) return
    await mutate(id, (current) => {
      const pool = current!
      pool.workers[sessionID].stopReason = reason
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
      const previous = pool.approvals[input.key]
      if (previous) {
        if (previous.unit !== input.unit || previous.amount !== input.amount || previous.revision !== input.revision)
          throw new Error("Approval key conflict")
        return { pool, result: pool }
      }
      if (pool.revision !== input.revision)
        throw new Error("Subagent allowance revision changed; refresh before approving")
      if (input.amount <= 0) throw new Error("Increase must be positive")
      pool.limits[input.unit] = Amount.parse(pool.limits[input.unit] + Amount.parse(input.amount))
      pool.approvals[input.key] = { unit: input.unit, amount: input.amount, revision: input.revision }
      return { pool, result: pool }
    })
  }
}
