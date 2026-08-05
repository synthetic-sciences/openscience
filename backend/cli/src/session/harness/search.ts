import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"
import { HarnessLaunch } from "./launch"

export namespace HarnessSearch {
  export const Stop = z.enum(["budget_exhausted", "objective_met", "no_improvement", "user_cancelled", "runtime_error"])
  export type Stop = z.infer<typeof Stop>

  export const Strategy = z.enum(["seed", "explore", "exploit", "fuse", "migrate", "diverge"])
  export type Strategy = z.infer<typeof Strategy>

  export const Mode = z.enum(["single-pass", "stepwise", "diff"])
  export type Mode = z.infer<typeof Mode>

  export const Operator = z.enum([
    "bug-fix",
    "external-dependency",
    "architectural-change",
    "composition",
    "local-refinement",
    "pruning",
    "refactor",
    "efficiency",
    "hyperparameter-tuning",
  ])
  export type Operator = z.infer<typeof Operator>

  export const Mandate = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      protocol: z.literal("agentic-variation-v1"),
      operator: Operator,
      instruction: z.string().min(1).max(1_000),
    })
    .strict()
  export type Mandate = z.infer<typeof Mandate>

  export const Artifact = z
    .object({
      uri: z.string().min(1).max(2_048),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
  export type Artifact = z.infer<typeof Artifact>

  export const Result = z
    .object({
      source: z.enum(["observed", "screened", "verified"]),
      status: HarnessEvaluation.Status,
      score: z.number().finite().optional(),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "A candidate result may contain at most 128 metrics")
        .default({}),
      checks: z.array(HarnessEvaluation.Check).default([]),
      evidence: z.array(z.string().min(1).max(1_000)).max(128).default([]),
      usage: HarnessEvaluation.Usage.optional(),
      fidelity: z
        .object({ stage: z.string().min(1).max(100), final: z.boolean() })
        .strict()
        .optional(),
      feedback: z.string().max(8_000).optional(),
      evaluator: z.string().max(200).optional(),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Result = z.infer<typeof Result>

  export const Lease = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      revision: z.number().int().nonnegative(),
      strategy: Strategy,
      mode: Mode,
      targetIsland: z.number().int().nonnegative(),
      contextIDs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(6)
        .refine((ids) => new Set(ids).size === ids.length, "Recommendation context must be unique"),
    })
    .strict()
  export type Lease = z.infer<typeof Lease>

  export const Candidate = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      parentIDs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(2)
        .refine((ids) => new Set(ids).size === ids.length, "Candidate parents must be unique"),
      inspirationIDs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(2)
        .refine((ids) => new Set(ids).size === ids.length, "Candidate inspirations must be unique")
        .default([]),
      branch: z.string().min(1).max(120),
      generation: z.number().int().nonnegative(),
      island: z.number().int().nonnegative().default(0),
      ordinal: z.number().int().nonnegative().optional(),
      proposal: z.string().min(1).max(4_000),
      artifact: Artifact,
      lease: Lease.optional(),
      reservationID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      result: Result.optional(),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Candidate = z.infer<typeof Candidate>

  export const Reservation = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      ordinal: z.number().int().nonnegative(),
      parentIDs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(2)
        .refine((ids) => new Set(ids).size === ids.length, "Reservation parents must be unique"),
      inspirationIDs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(2)
        .refine((ids) => new Set(ids).size === ids.length, "Reservation inspirations must be unique"),
      lease: Lease,
      mandate: Mandate.optional(),
      status: z.enum(["open", "consumed", "released"]),
      candidateID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      createdAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
  export type Reservation = z.infer<typeof Reservation>

  export const Population = z
    .object({
      mode: z.enum(["legacy", "islands"]),
      count: z.number().int().min(1).max(4),
      topology: z.literal("ring"),
      migrationInterval: z.number().int().positive(),
    })
    .strict()
  export type Population = z.infer<typeof Population>

  export const State = z
    .object({
      schemaVersion: z.literal(3),
      proposalPolicy: z.enum(["advisory-v2", "leased-v3"]),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      objective: z.string().min(1),
      evaluator: z.string().min(1),
      metric: z.string().min(1),
      direction: z.enum(["maximize", "minimize", "pass"]),
      target: z.number().finite().optional(),
      objectives: HarnessContract.Objectives.default([]),
      population: Population,
      budget: z
        .object({
          candidates: z.number().int().positive(),
          wallTimeMs: z.number().int().positive().optional(),
          stall: z.number().int().positive().default(5),
        })
        .strict(),
      status: z.enum(["active", "completed"]),
      stopReason: Stop.optional(),
      candidates: z.record(z.string(), Candidate),
      reservations: z.record(z.string(), Reservation).default({}),
      bestID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      archiveIDs: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .refine((items) => new Set(items).size === items.length, "Pareto archive candidates must be unique")
        .default([]),
      stalled: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      startedAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
  export type State = z.infer<typeof State>

  export type Recommendation = Lease & {
    parentIDs: string[]
    inspirationIDs: string[]
    reasons: string[]
  }

  type Route = Omit<Recommendation, "id" | "revision" | "mode" | "contextIDs">

  const root = path.join(Global.Path.data, "harness", "search")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  const candidates = (state: State) => Object.values(state.candidates)
  const reservations = (state: State) => Object.values(state.reservations)
  const open = (state: State) => reservations(state).filter((item) => item.status === "open")
  const verified = (candidate: Candidate) =>
    candidate.result?.source === "verified" && candidate.result.status === "passed"

  const identity = (
    input: Pick<
      Candidate,
      "parentIDs" | "inspirationIDs" | "branch" | "proposal" | "artifact" | "lease" | "reservationID"
    >,
  ) =>
    digest({
      parentIDs: input.parentIDs.toSorted(),
      inspirationIDs: input.inspirationIDs.toSorted(),
      branch: input.branch,
      proposal: input.proposal,
      artifact: input.artifact,
      ...(input.lease ? { lease: input.lease } : {}),
      ...(input.reservationID ? { reservationID: input.reservationID } : {}),
    })

  const leaseID = (state: Pick<State, "runID" | "sessionID">, input: Omit<Recommendation, "id" | "reasons">) =>
    digest({
      runID: state.runID,
      sessionID: state.sessionID,
      revision: input.revision,
      strategy: input.strategy,
      mode: input.mode,
      parentIDs: input.parentIDs.toSorted(),
      inspirationIDs: input.inspirationIDs.toSorted(),
      targetIsland: input.targetIsland,
      contextIDs: input.contextIDs,
    })

  const mandateID = (input: Omit<Mandate, "id">) => digest(input)

  const reservationID = (
    state: Pick<State, "runID" | "sessionID">,
    input: Pick<Reservation, "ordinal" | "parentIDs" | "inspirationIDs" | "lease" | "mandate" | "createdAt">,
  ) =>
    digest({
      runID: state.runID,
      sessionID: state.sessionID,
      ordinal: input.ordinal,
      parentIDs: input.parentIDs.toSorted(),
      inspirationIDs: input.inspirationIDs.toSorted(),
      lease: input.lease,
      ...(input.mandate ? { mandate: input.mandate } : {}),
      createdAt: input.createdAt,
    })

  function order(state: State, left: Candidate, right: Candidate) {
    if (state.direction === "pass") return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    const a = left.result?.score
    const b = right.result?.score
    if (a === undefined && b === undefined) return left.id.localeCompare(right.id)
    if (a === undefined) return 1
    if (b === undefined) return -1
    const delta = state.direction === "maximize" ? b - a : a - b
    return delta || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  }

  const ranked = (state: State) =>
    candidates(state)
      .filter(verified)
      .toSorted((a, b) => order(state, a, b))

  const values = (state: State, candidate: Candidate) => {
    if (state.direction === "pass") return []
    return [
      { direction: state.direction, value: candidate.result?.score },
      ...state.objectives.map((item) => ({ ...item, value: candidate.result?.metrics[item.metric] })),
    ]
  }

  const dominates = (state: State, left: Candidate, right: Candidate) => {
    const a = values(state, left)
    const b = values(state, right)
    if (!a.length || a.some((item) => item.value === undefined) || b.some((item) => item.value === undefined)) {
      return false
    }
    const deltas = a.map((item, index) => {
      const other = b[index]!
      if (item.direction !== other.direction) throw new Error(`Pareto objective directions are inconsistent`)
      return item.direction === "maximize" ? item.value! - other.value! : other.value! - item.value!
    })
    return deltas.every((delta) => delta >= 0) && deltas.some((delta) => delta > 0)
  }

  const archive = (state: State) => {
    const pool = ranked(state)
    return pool.filter(
      (candidate) => !pool.some((other) => other.id !== candidate.id && dominates(state, other, candidate)),
    )
  }

  export const frontier = (input: State) => archive(State.parse(input))

  const reached = (state: State, candidate: Candidate) => {
    if (!verified(candidate)) return false
    if (state.direction === "pass") return true
    if (state.target === undefined || candidate.result?.score === undefined) return false
    if (state.direction === "maximize") return candidate.result.score >= state.target
    return candidate.result.score <= state.target
  }

  const expired = (state: State, now: number) =>
    state.budget.wallTimeMs !== undefined && now - state.startedAt >= state.budget.wallTimeMs

  const population = (budget: number): Population => {
    const count = budget < 6 ? 1 : Math.min(4, Math.floor(Math.sqrt(budget / 2)))
    return {
      mode: "islands",
      count,
      topology: "ring",
      migrationInterval: Math.max(2, Math.ceil(budget / (count * 2))),
    }
  }

  const vacancy = (state: State) => {
    const counts = Array.from({ length: state.population.count }, () => 0)
    for (const candidate of candidates(state)) counts[candidate.island] = (counts[candidate.island] ?? 0) + 1
    const least = Math.min(...counts)
    return counts.findIndex((count) => count === least)
  }

  const stop = (state: State, reason: Stop, now = Date.now()): State => ({
    ...state,
    status: "completed",
    stopReason: reason,
    reservations: Object.fromEntries(
      reservations(state).map((item) => [
        item.id,
        item.status === "open" ? { ...item, status: "released" as const, updatedAt: now } : item,
      ]),
    ),
    revision: state.revision + 1,
    updatedAt: now,
  })

  function topology(state: State) {
    if (state.proposalPolicy === "leased-v3" && state.population.mode !== "islands") {
      throw new Error(`Leased search state must use the server-derived island policy`)
    }
    if (state.population.mode === "legacy") {
      if (candidates(state).some((candidate) => candidate.ordinal !== undefined || candidate.island !== 0)) {
        throw new Error(`Legacy search state cannot contain island assignments`)
      }
      return
    }
    if (JSON.stringify(state.population) !== JSON.stringify(population(state.budget.candidates))) {
      throw new Error(`Persisted island policy does not match the server-derived budget policy`)
    }
    const items = candidates(state).toSorted(
      (a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER),
    )
    if (items.some((candidate, index) => candidate.ordinal !== index)) {
      throw new Error(`Persisted island candidate order is not contiguous`)
    }
    const seen = new Map<string, Candidate>()
    const claimed = new Set<string>()
    const hashes = new Set<string>()
    const counts = Array.from({ length: state.population.count }, () => 0)
    for (const candidate of items) {
      if (identity(candidate) !== candidate.id)
        throw new Error(`Persisted candidate identity does not match its content`)
      if (hashes.has(candidate.artifact.sha256)) throw new Error(`Persisted search contains duplicate artifact content`)
      hashes.add(candidate.artifact.sha256)
      const parents = candidate.parentIDs.map((id) => seen.get(id))
      const inspirations = candidate.inspirationIDs.map((id) => seen.get(id))
      if (parents.some((parent) => !parent) || inspirations.some((item) => !item)) {
        throw new Error(`Persisted candidate lineage must reference earlier candidates`)
      }
      if (parents.some((parent) => !verified(parent!)) || inspirations.some((item) => !verified(item!))) {
        throw new Error(`Persisted candidate lineage must reference verified passing candidates`)
      }
      if (candidate.inspirationIDs.some((id) => candidate.parentIDs.includes(id))) {
        throw new Error(`Candidate inspirations must be distinct from parents`)
      }
      if (candidate.reservationID) {
        if (claimed.has(candidate.reservationID)) throw new Error(`A reservation may authorize only one candidate`)
        claimed.add(candidate.reservationID)
      }
      if (state.proposalPolicy === "leased-v3") {
        if (!candidate.lease) throw new Error(`Leased search candidate is missing recommendation provenance`)
        if (candidate.lease.targetIsland !== candidate.island) {
          throw new Error(`Persisted recommendation target does not match candidate island`)
        }
        const context = candidate.lease.contextIDs.map((id) => seen.get(id))
        if (context.some((item) => !item || !verified(item))) {
          throw new Error(`Persisted recommendation context must reference earlier verified passing candidates`)
        }
        const expected = leaseID(state, {
          revision: candidate.lease.revision,
          strategy: candidate.lease.strategy,
          mode: candidate.lease.mode,
          parentIDs: candidate.parentIDs,
          inspirationIDs: candidate.inspirationIDs,
          targetIsland: candidate.lease.targetIsland,
          contextIDs: candidate.lease.contextIDs,
        })
        if (candidate.lease.id !== expected) {
          throw new Error(`Persisted recommendation identity does not match its content`)
        }
      }
      const least = Math.min(...counts)
      const expected = candidate.reservationID
        ? candidate.lease?.targetIsland
        : parents.length
          ? parents.toSorted((a, b) => order(state, a!, b!))[0]!.island
          : counts.findIndex((count) => count === least)
      if (candidate.island !== expected || candidate.island >= state.population.count) {
        throw new Error(`Persisted candidate island does not match server assignment`)
      }
      const generation = parents.length ? Math.max(...parents.map((parent) => parent!.generation)) + 1 : 0
      if (candidate.generation !== generation) {
        throw new Error(`Persisted candidate generation does not match its lineage`)
      }
      counts[candidate.island] = counts[candidate.island]! + 1
      seen.set(candidate.id, candidate)
    }
    const tickets = reservations(state).toSorted((a, b) => a.ordinal - b.ordinal)
    if (tickets.some((item, index) => item.ordinal !== index)) {
      throw new Error(`Persisted reservation order is not contiguous`)
    }
    for (const item of tickets) {
      if (reservationID(state, item) !== item.id) {
        throw new Error(`Persisted reservation identity does not match its content`)
      }
      if (
        item.mandate &&
        mandateID({
          protocol: item.mandate.protocol,
          operator: item.mandate.operator,
          instruction: item.mandate.instruction,
        }) !== item.mandate.id
      ) {
        throw new Error(`Persisted variation mandate identity does not match its content`)
      }
      if (item.updatedAt < item.createdAt) throw new Error(`Persisted reservation timestamps are invalid`)
      if (item.inspirationIDs.some((id) => item.parentIDs.includes(id))) {
        throw new Error(`Reservation inspirations must be distinct from parents`)
      }
      if (item.lease.targetIsland >= state.population.count) {
        throw new Error(`Persisted reservation target island is outside the search population`)
      }
      const parents = item.parentIDs.map((id) => state.candidates[id])
      const inspirations = item.inspirationIDs.map((id) => state.candidates[id])
      const context = item.lease.contextIDs.map((id) => state.candidates[id])
      if (
        parents.some((candidate) => !candidate || !verified(candidate)) ||
        inspirations.some((candidate) => !candidate || !verified(candidate)) ||
        context.some((candidate) => !candidate || !verified(candidate))
      ) {
        throw new Error(`Persisted reservation may reference only verified passing candidates`)
      }
      const expected = leaseID(state, {
        revision: item.lease.revision,
        strategy: item.lease.strategy,
        mode: item.lease.mode,
        parentIDs: item.parentIDs,
        inspirationIDs: item.inspirationIDs,
        targetIsland: item.lease.targetIsland,
        contextIDs: item.lease.contextIDs,
      })
      if (item.lease.id !== expected) throw new Error(`Persisted reservation lease does not match its content`)
      if (item.status === "open" && item.candidateID) {
        throw new Error(`An open reservation cannot name a candidate`)
      }
      if (item.status === "released" && item.candidateID && !state.candidates[item.candidateID]) {
        throw new Error(`A duplicate-released reservation must name an existing candidate`)
      }
      if (item.status === "consumed") {
        const candidate = item.candidateID ? state.candidates[item.candidateID] : undefined
        if (!candidate || candidate.reservationID !== item.id) {
          throw new Error(`A consumed reservation must name its authorized candidate`)
        }
      }
    }
  }

  function parse(data: Record<string, unknown>) {
    const migrated =
      data.schemaVersion === 1
        ? {
            ...data,
            schemaVersion: 3,
            proposalPolicy: "advisory-v2",
            population: { mode: "legacy", count: 1, topology: "ring", migrationInterval: 1 },
          }
        : data.schemaVersion === 2
          ? { ...data, schemaVersion: 3, proposalPolicy: "advisory-v2" }
          : data
    const parsed = State.parse(migrated)
    const expected = archive(parsed).map((item) => item.id)
    const state = "archiveIDs" in data ? parsed : State.parse({ ...parsed, archiveIDs: expected })
    if (JSON.stringify(state.archiveIDs) !== JSON.stringify(expected)) {
      throw new Error(`Persisted Pareto archive does not match verified candidate results`)
    }
    topology(state)
    return state
  }

  export async function initialize(input: {
    sessionID: string
    candidates?: number
    wallTimeMs?: number
    stall?: number
    target?: number
  }) {
    const contract = await HarnessContract.read(input.sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${input.sessionID}`)
    await HarnessLaunch.ready(contract)
    if (contract.profile !== "optimize") throw new Error(`Harness search requires the optimize profile`)
    const candidates = input.candidates ?? contract.budget.candidates
    if (!candidates) throw new Error(`The optimize contract must declare a candidate budget`)
    if (contract.budget.candidates !== undefined && candidates > contract.budget.candidates) {
      throw new Error(`Harness search cannot exceed the contract candidate budget`)
    }
    if (
      contract.benchmark.target !== undefined &&
      input.target !== undefined &&
      contract.benchmark.target !== input.target
    ) {
      throw new Error(`Harness search target does not match the benchmark contract`)
    }
    const wallTimeMs = input.wallTimeMs ?? contract.budget.wallTimeMs
    if (
      contract.budget.wallTimeMs !== undefined &&
      wallTimeMs !== undefined &&
      wallTimeMs > contract.budget.wallTimeMs
    ) {
      throw new Error(`Harness search cannot exceed the contract wall-time budget`)
    }
    const now = Date.now()
    const initial: State = {
      schemaVersion: 3,
      proposalPolicy: "leased-v3",
      runID: contract.runID,
      sessionID: input.sessionID,
      objective: contract.objective,
      evaluator: contract.benchmark.evaluator,
      metric: contract.benchmark.metric ?? "status",
      direction: contract.benchmark.direction ?? "pass",
      objectives: contract.benchmark.objectives ?? [],
      population: population(candidates),
      ...(contract.benchmark.target === undefined && input.target === undefined
        ? {}
        : { target: contract.benchmark.target ?? input.target }),
      budget: {
        candidates,
        ...(wallTimeMs === undefined ? {} : { wallTimeMs }),
        stall: input.stall ?? 5,
      },
      status: "active",
      candidates: {},
      reservations: {},
      archiveIDs: [],
      stalled: 0,
      revision: 0,
      startedAt: now,
      updatedAt: now,
    }
    const expected = State.parse(initial)
    await JsonStore.update(file(input.sessionID), (data) => {
      if (!Object.keys(data).length) return expected
      const state = parse(data)
      const stable = [
        "runID",
        "sessionID",
        "objective",
        "evaluator",
        "metric",
        "direction",
        "target",
        "objectives",
        "budget",
      ] as const
      if (stable.every((key) => JSON.stringify(state[key]) === JSON.stringify(expected[key]))) return state
      throw new Error(`Harness search already exists with a different contract or budget`)
    })
    return read(input.sessionID)
  }

  export async function read(sessionID: string): Promise<State> {
    return parse(await JsonStore.read(file(sessionID)))
  }

  export async function reserve(input: { sessionID: string; count: number }) {
    const count = z.number().int().min(1).max(8).parse(input.count)
    const issued: Reservation[] = []
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const now = Date.now()
      if (state.proposalPolicy !== "leased-v3") {
        throw new Error(`Parallel reservations require the leased-v3 proposal policy`)
      }
      if (state.status !== "active") return state
      if (expired(state, now)) return stop(state, "budget_exhausted", now)
      const remaining = Math.max(0, state.budget.candidates - candidates(state).length - open(state).length)
      const choice = recommend(state)
      const roots = candidates(state).filter(
        (candidate) =>
          !candidate.parentIDs.length &&
          (candidate.result === undefined ||
            (candidate.result.source === "verified" && candidate.result.status === "passed")),
      )
      const rootLimit = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(state.budget.candidates))))
      const openRoots = open(state).filter((item) => !item.parentIDs.length).length
      const capacity = choice.parentIDs.length
        ? remaining
        : Math.max(0, Math.min(remaining, rootLimit - roots.length - openRoots))
      const size = Math.min(count, capacity)
      if (!size) return state
      const start = reservations(state).length
      const plans = portfolio(state, size, start, openRoots)
      const additions = plans.map((plan, index) => {
        const lease = Lease.parse({
          id: plan.recommendation.id,
          revision: plan.recommendation.revision,
          strategy: plan.recommendation.strategy,
          mode: plan.recommendation.mode,
          targetIsland: plan.recommendation.targetIsland,
          contextIDs: plan.recommendation.contextIDs,
        })
        const draft = {
          ordinal: start + index,
          parentIDs: plan.recommendation.parentIDs.toSorted(),
          inspirationIDs: plan.recommendation.inspirationIDs.toSorted(),
          lease,
          mandate: plan.mandate,
          status: "open" as const,
          createdAt: now,
          updatedAt: now,
        }
        return Reservation.parse({ id: reservationID(state, draft), ...draft })
      })
      issued.push(...additions)
      return {
        ...state,
        reservations: {
          ...state.reservations,
          ...Object.fromEntries(additions.map((item) => [item.id, item])),
        },
        revision: state.revision + 1,
        updatedAt: now,
      }
    })
    return { reservations: issued, state: await read(input.sessionID) }
  }

  export async function release(input: { sessionID: string; reservationID: string }) {
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const reservation = state.reservations[input.reservationID]
      if (!reservation) throw new Error(`Unknown reservation ${input.reservationID}`)
      if (reservation.status === "released") return state
      if (reservation.status === "consumed") throw new Error(`A consumed reservation cannot be released`)
      const now = Date.now()
      return {
        ...state,
        reservations: {
          ...state.reservations,
          [reservation.id]: { ...reservation, status: "released", updatedAt: now },
        },
        revision: state.revision + 1,
        updatedAt: now,
      }
    })
    return read(input.sessionID)
  }

  export async function add(input: {
    sessionID: string
    recommendationID?: string
    reservationID?: string
    parentIDs: string[]
    inspirationIDs?: string[]
    branch: string
    proposal: string
    artifact: Artifact
  }) {
    if (input.recommendationID && input.reservationID) {
      throw new Error(`A proposal must use either a recommendation or a reservation, not both`)
    }
    const artifact = Artifact.parse(input.artifact)
    const parents = input.parentIDs.toSorted()
    const inspirations = (input.inspirationIDs ?? []).toSorted()
    const initial = identity({
      parentIDs: parents,
      inspirationIDs: inspirations,
      branch: input.branch,
      proposal: input.proposal,
      artifact,
    })
    const out = { accepted: false, deduplicated: false, id: initial }
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const reservation = input.reservationID ? state.reservations[input.reservationID] : undefined
      if (input.reservationID && !reservation) throw new Error(`Unknown reservation ${input.reservationID}`)
      const existing = candidates(state).find((candidate) => candidate.artifact.sha256 === artifact.sha256)
      if (existing) {
        out.accepted = true
        out.deduplicated = true
        out.id = existing.id
        if (!reservation) return state
        if (reservation.candidateID === existing.id) return state
        if (reservation.status !== "open") throw new Error(`Reservation is no longer open`)
        const now = Date.now()
        return {
          ...state,
          reservations: {
            ...state.reservations,
            [reservation.id]: { ...reservation, status: "released", candidateID: existing.id, updatedAt: now },
          },
          revision: state.revision + 1,
          updatedAt: now,
        }
      }
      const now = Date.now()
      if (state.status !== "active") return state
      if (expired(state, now) || candidates(state).length >= state.budget.candidates) {
        return stop(state, "budget_exhausted", now)
      }
      if (!reservation && candidates(state).length + open(state).length >= state.budget.candidates) return state
      if (reservation?.status !== undefined && reservation.status !== "open") {
        throw new Error(`Reservation is no longer open`)
      }
      if (parents.length > 2) throw new Error(`A candidate may have at most two parents`)
      if (new Set(parents).size !== parents.length) throw new Error(`Candidate parents must be unique`)
      if (inspirations.length > 2) throw new Error(`A candidate may have at most two inspirations`)
      if (new Set(inspirations).size !== inspirations.length) throw new Error(`Candidate inspirations must be unique`)
      if (inspirations.some((id) => parents.includes(id))) {
        throw new Error(`Candidate inspirations must be distinct from parents`)
      }
      const ancestors = parents.map((parent) => state.candidates[parent])
      const sources = inspirations.map((item) => state.candidates[item])
      if (ancestors.some((parent) => !parent)) throw new Error(`Every candidate parent must exist in the same search`)
      if (sources.some((item) => !item)) throw new Error(`Every candidate inspiration must exist in the same search`)
      if (ancestors.some((parent) => !verified(parent!))) {
        throw new Error(`Candidates may only descend from externally verified passing parents`)
      }
      if (sources.some((item) => !verified(item!))) {
        throw new Error(`Candidates may only use externally verified passing inspirations`)
      }
      const recommendation: Recommendation | undefined = reservation
        ? {
            ...reservation.lease,
            parentIDs: reservation.parentIDs,
            inspirationIDs: reservation.inspirationIDs,
            reasons: ["budget-backed-parallel-reservation"],
          }
        : state.proposalPolicy === "leased-v3"
          ? recommend(state)
          : undefined
      if (recommendation && !input.recommendationID && !reservation) {
        throw new Error(`A current recommendation_id or reservation_id is required by the leased proposal policy`)
      }
      if (recommendation && !reservation && recommendation.id !== input.recommendationID) {
        throw new Error(`Recommendation lease is stale or belongs to a different search state`)
      }
      if (
        recommendation &&
        (JSON.stringify(parents) !== JSON.stringify(recommendation.parentIDs.toSorted()) ||
          JSON.stringify(inspirations) !== JSON.stringify(recommendation.inspirationIDs.toSorted()))
      ) {
        throw new Error(`Proposal lineage does not match the leased recommendation`)
      }
      if (!parents.length) {
        const roots = candidates(state).filter(
          (candidate) =>
            !candidate.parentIDs.length &&
            (candidate.result === undefined ||
              (candidate.result.source === "verified" && candidate.result.status === "passed")),
        )
        const limit = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(state.budget.candidates))))
        const held = reservation ? 0 : open(state).filter((item) => !item.parentIDs.length).length
        if (roots.length + held >= limit) throw new Error(`Independent candidate root budget is exhausted`)
        if (roots.some((candidate) => candidate.branch === input.branch)) {
          throw new Error(`An active independent root already exists for branch ${input.branch}`)
        }
      }
      const generation = ancestors.length ? Math.max(...ancestors.map((parent) => parent!.generation)) + 1 : 0
      const derived = ancestors.length ? ancestors.toSorted((a, b) => order(state, a!, b!))[0]!.island : vacancy(state)
      const island = reservation?.lease.targetIsland ?? derived
      if (recommendation && ancestors.length && derived !== recommendation.targetIsland) {
        throw new Error(`Server island assignment does not match the leased recommendation`)
      }
      const lease =
        reservation?.lease ??
        (recommendation
          ? Lease.parse({
              id: recommendation.id,
              revision: recommendation.revision,
              strategy: recommendation.strategy,
              mode: recommendation.mode,
              targetIsland: recommendation.targetIsland,
              contextIDs: recommendation.contextIDs,
            })
          : undefined)
      const id = identity({
        parentIDs: parents,
        inspirationIDs: inspirations,
        branch: input.branch,
        proposal: input.proposal,
        artifact,
        lease,
        reservationID: reservation?.id,
      })
      const candidate: Candidate = Candidate.parse({
        id,
        parentIDs: parents,
        inspirationIDs: inspirations,
        branch: input.branch,
        generation,
        island,
        ...(state.population.mode === "legacy" ? {} : { ordinal: candidates(state).length }),
        proposal: input.proposal,
        artifact,
        lease,
        reservationID: reservation?.id,
        createdAt: now,
      })
      out.accepted = true
      out.id = id
      return {
        ...state,
        candidates: { ...state.candidates, [id]: candidate },
        reservations: reservation
          ? {
              ...state.reservations,
              [reservation.id]: { ...reservation, status: "consumed", candidateID: id, updatedAt: now },
            }
          : state.reservations,
        revision: state.revision + 1,
        updatedAt: now,
      }
    })
    return { ...out, state: await read(input.sessionID) }
  }

  export async function observe(input: {
    sessionID: string
    candidateID: string
    status: HarnessEvaluation.Status
    score?: number
    metrics?: Record<string, number>
    evidence?: string[]
    feedback?: string
  }) {
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const candidate = state.candidates[input.candidateID]
      if (!candidate) throw new Error(`Unknown candidate ${input.candidateID}`)
      if (candidate.result?.source === "verified" || candidate.result?.source === "screened") {
        throw new Error(`An external result cannot be replaced by an observation`)
      }
      const now = Date.now()
      const result = Result.parse({
        source: "observed",
        status: input.status,
        ...(input.score === undefined ? {} : { score: input.score }),
        metrics: input.metrics ?? {},
        evidence: input.evidence ?? [],
        feedback: input.feedback,
        evaluatedAt: now,
      })
      return {
        ...state,
        candidates: { ...state.candidates, [candidate.id]: { ...candidate, result } },
        revision: state.revision + 1,
        updatedAt: now,
      }
    })
    return read(input.sessionID)
  }

  export async function verify(input: { sessionID: string; candidateID: string }) {
    const evaluation = (await HarnessEvaluation.list(input.sessionID)).findLast(
      (item) =>
        item.subject?.type === "candidate" && item.subject.id === input.candidateID && HarnessEvaluation.final(item),
    )
    if (!evaluation) {
      const latest = await HarnessEvaluation.read(input.sessionID)
      if (latest) throw new Error(`The recorded evaluation is not bound to candidate ${input.candidateID}`)
      throw new Error(`No recorded external evaluation exists for session ${input.sessionID}`)
    }
    if (evaluation.subject?.type !== "candidate" || evaluation.subject.id !== input.candidateID) {
      throw new Error(`The recorded evaluation is not bound to candidate ${input.candidateID}`)
    }
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const candidate = state.candidates[input.candidateID]
      if (!candidate) throw new Error(`Unknown candidate ${input.candidateID}`)
      if (state.runID !== evaluation.runID) throw new Error(`Evaluation belongs to a different harness run`)
      if (state.evaluator !== evaluation.evaluator.name) throw new Error(`Evaluation belongs to a different evaluator`)
      if (state.direction !== "pass" && evaluation.status === "passed" && evaluation.score === undefined) {
        throw new Error(`A ${state.direction} search requires a numeric evaluator score`)
      }
      if (evaluation.status === "passed") {
        const missing = state.objectives.find((item) => evaluation.metrics[item.metric] === undefined)
        if (missing) throw new Error(`Passing evaluation is missing declared objective metric ${missing.metric}`)
      }
      const now = Date.now()
      const before = state.bestID
      const result = Result.parse({
        source: "verified",
        status: evaluation.status,
        score: evaluation.score,
        metrics: evaluation.metrics,
        checks: evaluation.checks,
        evidence: evaluation.evidence,
        usage: evaluation.usage,
        fidelity: evaluation.fidelity,
        evaluator: evaluation.evaluator.name,
        feedback: evaluation.notes,
        evaluatedAt: evaluation.evaluatedAt,
      })
      if (candidate.result?.source === "verified") {
        if (JSON.stringify(candidate.result) === JSON.stringify(result)) return state
        throw new Error(`A verified candidate result is immutable`)
      }
      const updated = { ...candidate, result }
      const pool = { ...state.candidates, [candidate.id]: updated }
      const provisional = { ...state, candidates: pool }
      const best = ranked(provisional)[0]
      const archiveIDs = archive(provisional).map((item) => item.id)
      const improved = best?.id === candidate.id && before !== candidate.id
      const next: State = {
        ...provisional,
        bestID: best?.id,
        archiveIDs,
        stalled: improved ? 0 : state.stalled + 1,
        revision: state.revision + 1,
        updatedAt: now,
      }
      if (reached(next, updated)) return stop(next, "objective_met", now)
      if (
        candidates(next).length >= next.budget.candidates &&
        candidates(next).every((item) => item.result?.source === "verified")
      ) {
        return stop(next, "budget_exhausted", now)
      }
      return next
    })
    return read(input.sessionID)
  }

  export async function screen(input: { sessionID: string; candidateID: string; evaluation: HarnessEvaluation.Info }) {
    const evaluation = HarnessEvaluation.Info.parse(input.evaluation)
    if (evaluation.fidelity?.final !== false) throw new Error(`Screening requires a non-final fidelity stage`)
    if (evaluation.subject?.type !== "candidate" || evaluation.subject.id !== input.candidateID) {
      throw new Error(`Screening evaluation is not bound to candidate ${input.candidateID}`)
    }
    const [contract, journal] = await Promise.all([
      HarnessContract.read(input.sessionID),
      HarnessEvaluation.list(input.sessionID),
    ])
    if (!contract?.benchmark.fidelities) throw new Error(`Screening requires a bound fidelity plan`)
    const plan = contract.benchmark.fidelities
    if (!journal.some((item) => HarnessEvaluation.fingerprint(item) === HarnessEvaluation.fingerprint(evaluation))) {
      throw new Error(`Screening requires a recorded external evaluation`)
    }
    const index = plan.findIndex((item) => item.id === evaluation.fidelity?.stage)
    if (index < 0) throw new Error(`Screening fidelity stage is not in the bound contract`)
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const candidate = state.candidates[input.candidateID]
      if (!candidate) throw new Error(`Unknown candidate ${input.candidateID}`)
      if (candidate.result?.source === "verified") throw new Error(`A final verified result is immutable`)
      const result = Result.parse({
        source: "screened",
        status: evaluation.status,
        score: evaluation.score,
        metrics: evaluation.metrics,
        checks: evaluation.checks,
        evidence: evaluation.evidence,
        usage: evaluation.usage,
        fidelity: evaluation.fidelity,
        evaluator: evaluation.evaluator.name,
        feedback: evaluation.notes,
        evaluatedAt: evaluation.evaluatedAt,
      })
      if (candidate.result?.source === "screened") {
        if (JSON.stringify(candidate.result) === JSON.stringify(result)) return state
        const current = plan.findIndex((item) => item.id === candidate.result?.fidelity?.stage)
        if (current >= index) throw new Error(`A screening result cannot replace the same or a later fidelity stage`)
      }
      return {
        ...state,
        candidates: { ...state.candidates, [candidate.id]: { ...candidate, result } },
        revision: state.revision + 1,
        updatedAt: Date.now(),
      }
    })
    return read(input.sessionID)
  }

  export async function finish(sessionID: string, reason: Exclude<Stop, "budget_exhausted" | "objective_met">) {
    await JsonStore.update(file(sessionID), (data) => {
      const state = parse(data)
      if (state.status === "completed") return state
      return stop(state, reason)
    })
    return read(sessionID)
  }

  function route(state: State): Route {
    const pool = ranked(state)
    if (!pool.length) {
      return {
        strategy: "seed",
        parentIDs: [],
        inspirationIDs: [],
        targetIsland: vacancy(state),
        reasons: ["no-verified-candidate"],
      }
    }
    const pareto = archive(state)
    const prioritized = [...pareto, ...pool.filter((candidate) => !pareto.some((item) => item.id === candidate.id))]
    const distinct = prioritized.filter(
      (candidate, index) => prioritized.findIndex((item) => item.branch === candidate.branch) === index,
    )
    if (state.stalled >= state.budget.stall * 2) {
      return {
        strategy: "diverge",
        parentIDs: [pool[0]!.id],
        inspirationIDs: [],
        targetIsland: pool[0]!.island,
        reasons: [`stalled:${state.stalled}`, "strategy-level-mutation", "preserve-best"],
      }
    }
    if (
      state.population.mode === "islands" &&
      state.population.count > 1 &&
      candidates(state).length >= state.population.migrationInterval &&
      candidates(state).length % state.population.migrationInterval === 0
    ) {
      const source = pool[0]!
      const target = Array.from(
        { length: state.population.count - 1 },
        (_, index) => (source.island + index + 1) % state.population.count,
      ).find((island) => pool.some((candidate) => candidate.island === island))
      const anchor = target === undefined ? undefined : pool.find((candidate) => candidate.island === target)
      if (anchor) {
        return {
          strategy: "migrate",
          parentIDs: [anchor.id],
          inspirationIDs: [source.id],
          targetIsland: anchor.island,
          reasons: [
            `candidates:${candidates(state).length}`,
            `ring:${source.island}->${anchor.island}`,
            "verified-inspiration",
            "new-artifact-required",
          ],
        }
      }
    }
    if (state.stalled >= state.budget.stall && distinct.length >= 2) {
      const best = pool[0]!
      const complement = prioritized.find((candidate) => candidate.branch !== best.branch)!
      return {
        strategy: "fuse",
        parentIDs: [best.id, complement.id],
        inspirationIDs: [],
        targetIsland: best.island,
        reasons: [
          `stalled:${state.stalled}`,
          "cross-branch-fusion",
          ...(state.objectives.length ? [`pareto-frontier:${pareto.length}`, "multi-metric-complementarity"] : []),
        ],
      }
    }
    const progress = candidates(state).length / state.budget.candidates
    const roots = candidates(state).filter(
      (candidate) =>
        !candidate.parentIDs.length &&
        (candidate.result === undefined ||
          (candidate.result.source === "verified" && candidate.result.status === "passed")),
    )
    const rootTarget = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(state.budget.candidates))))
    if (progress < 0.35 && roots.length < rootTarget) {
      return {
        strategy: "explore",
        parentIDs: [],
        inspirationIDs: [],
        targetIsland: vacancy(state),
        reasons: [`budget-progress:${progress.toFixed(2)}`, `independent-roots:${roots.length}/${rootTarget}`],
      }
    }
    if (progress >= 0.5) {
      return {
        strategy: "exploit",
        parentIDs: [pool[0]!.id],
        inspirationIDs: [],
        targetIsland: pool[0]!.island,
        reasons: [`budget-progress:${progress.toFixed(2)}`, "verified-rank"],
      }
    }
    const counts = new Map<string, number>()
    for (const candidate of candidates(state)) counts.set(candidate.branch, (counts.get(candidate.branch) ?? 0) + 1)
    const visits = distinct.map((candidate) => counts.get(candidate.branch) ?? 1)
    const least = Math.min(...visits)
    const warmup = distinct.filter((candidate) => (counts.get(candidate.branch) ?? 1) === least)
    const scale = Math.max(1, ...pool.map((candidate) => Math.abs(candidate.result?.score ?? 0)))
    const total = Math.max(1, candidates(state).length)
    const value = (candidate: Candidate) => {
      const raw = candidate.result?.score ?? 0
      const quality = state.direction === "minimize" ? -raw / scale : raw / scale
      const count = counts.get(candidate.branch) ?? 1
      return quality + Math.sqrt((2 * Math.log(total + 1)) / count)
    }
    const diverse = warmup.toSorted((a, b) => value(b) - value(a) || order(state, a, b))
    return {
      strategy: "explore",
      parentIDs: [diverse[0]!.id],
      inspirationIDs: [],
      targetIsland: diverse[0]!.island,
      reasons: [
        `budget-progress:${progress.toFixed(2)}`,
        `branch-visits:${least}`,
        warmup.length < distinct.length ? "ucb-minimum-visits" : "ucb-quality-exploration",
        ...(state.objectives.length ? [`pareto-frontier:${pareto.length}`] : []),
      ],
    }
  }

  const trail = (state: State, id: string) => {
    const found: string[] = []
    const visit = (key: string) => {
      const candidate = state.candidates[key]
      if (!candidate || !verified(candidate) || found.includes(key)) return
      found.push(key)
      for (const parent of candidate.parentIDs) visit(parent)
    }
    visit(id)
    return found
  }

  const instructions = {
    "bug-fix":
      "Diagnose a concrete correctness, execution, or validity failure and repair its root cause. Use tools and local checks freely, but return one new runnable artifact for external evaluation.",
    "external-dependency":
      "Investigate whether a justified external method, dataset, library, simulator, or reference implementation can improve this lineage. Integrate only what the task contract permits and return one reproducible artifact.",
    "architectural-change":
      "Pursue a materially different algorithm, representation, decomposition, or system architecture. Do not satisfy this mandate with parameter-only changes; plan, test, debug, and revise before returning one artifact.",
    composition:
      "Compose complementary mechanisms from the leased lineage and context into one coherent artifact. Resolve incompatibilities explicitly and test the integration before returning it.",
    "local-refinement":
      "Keep the core approach and make a focused evidence-driven improvement. Use the verified trajectory and feedback to choose the smallest high-leverage edit, then test and revise it.",
    pruning:
      "Remove, disable, or simplify a component that may be unnecessary, harmful, or overfit. Preserve the task contract and return a runnable artifact that makes the causal change inspectable.",
    refactor:
      "Reorganize the artifact to improve clarity, modularity, stability, or future evolvability without relying on a new scientific premise. Preserve intended behavior and validate the result.",
    efficiency:
      "Improve runtime, memory, sample efficiency, tool use, or cost while protecting the declared primary and secondary objectives. Measure locally when possible, then return one artifact for external evaluation.",
    "hyperparameter-tuning":
      "Keep the algorithmic structure fixed and tune constants, thresholds, schedules, or other parameters using a principled local search. Avoid presenting retuning as a new architecture.",
  } satisfies Record<Operator, string>

  const operators = {
    seed: [
      "architectural-change",
      "composition",
      "efficiency",
      "external-dependency",
      "local-refinement",
      "pruning",
      "refactor",
      "hyperparameter-tuning",
      "bug-fix",
    ],
    explore: [
      "architectural-change",
      "composition",
      "external-dependency",
      "efficiency",
      "local-refinement",
      "pruning",
      "refactor",
      "hyperparameter-tuning",
      "bug-fix",
    ],
    exploit: [
      "local-refinement",
      "efficiency",
      "hyperparameter-tuning",
      "pruning",
      "refactor",
      "composition",
      "bug-fix",
      "architectural-change",
      "external-dependency",
    ],
    fuse: [
      "composition",
      "architectural-change",
      "local-refinement",
      "efficiency",
      "pruning",
      "refactor",
      "hyperparameter-tuning",
      "bug-fix",
      "external-dependency",
    ],
    migrate: [
      "composition",
      "local-refinement",
      "architectural-change",
      "efficiency",
      "pruning",
      "refactor",
      "hyperparameter-tuning",
      "bug-fix",
      "external-dependency",
    ],
    diverge: [
      "architectural-change",
      "external-dependency",
      "composition",
      "pruning",
      "efficiency",
      "refactor",
      "bug-fix",
      "local-refinement",
      "hyperparameter-tuning",
    ],
  } satisfies Record<Strategy, Operator[]>

  function mandate(strategy: Strategy, ordinal: number): Mandate {
    const operator = operators[strategy][ordinal % operators[strategy].length]!
    const body = {
      protocol: "agentic-variation-v1" as const,
      operator,
      instruction: instructions[operator],
    }
    return Mandate.parse({ id: mandateID(body), ...body })
  }

  const routeID = (input: Route) =>
    JSON.stringify({
      strategy: input.strategy,
      parentIDs: input.parentIDs.toSorted(),
      inspirationIDs: input.inspirationIDs.toSorted(),
      targetIsland: input.targetIsland,
    })

  function routes(state: State) {
    const primary = route(state)
    const pool = ranked(state)
    if (!pool.length || !primary.parentIDs.length) return [primary]
    const pareto = archive(state)
    const ordered = [...pareto, ...pool.filter((candidate) => !pareto.some((item) => item.id === candidate.id))]
    const distinct = ordered.filter(
      (candidate, index) => ordered.findIndex((item) => item.branch === candidate.branch) === index,
    )
    const options: Route[] = [primary]
    const seen = new Set([routeID(primary)])
    const add = (choice: Route) => {
      const id = routeID(choice)
      if (seen.has(id)) return
      seen.add(id)
      options.push(choice)
    }
    if (primary.strategy === "fuse") {
      const best = pool[0]!
      for (const candidate of distinct) {
        if (candidate.branch === best.branch) continue
        add({
          strategy: "fuse",
          parentIDs: [best.id, candidate.id],
          inspirationIDs: [],
          targetIsland: best.island,
          reasons: ["portfolio-cross-branch-fusion", `source-branch:${candidate.branch}`],
        })
      }
      return options
    }
    if (primary.strategy === "migrate") {
      const source = pool[0]!
      const islands = pool.filter(
        (candidate, index) => pool.findIndex((item) => item.island === candidate.island) === index,
      )
      for (const anchor of islands) {
        if (anchor.island === source.island) continue
        add({
          strategy: "migrate",
          parentIDs: [anchor.id],
          inspirationIDs: [source.id],
          targetIsland: anchor.island,
          reasons: ["portfolio-ring-migration", `source:${source.island}`, `target:${anchor.island}`],
        })
      }
      return options
    }
    for (const candidate of distinct) {
      add({
        strategy: primary.strategy,
        parentIDs: [candidate.id],
        inspirationIDs: [],
        targetIsland: candidate.island,
        reasons: ["portfolio-verified-lineage", `branch:${candidate.branch}`],
      })
    }
    return options
  }

  function materialize(state: State, choice: Route): Recommendation {
    const mode: Mode =
      choice.strategy === "seed"
        ? "single-pass"
        : choice.strategy === "exploit" || (choice.strategy === "explore" && choice.parentIDs.length)
          ? "diff"
          : "stepwise"
    const roots = [...choice.parentIDs, ...choice.inspirationIDs]
    const trails = roots.map((id) => trail(state, id))
    const depth = Math.max(0, ...trails.map((items) => items.length))
    const contextIDs = Array.from({ length: depth }, (_, index) => trails.map((items) => items[index]))
      .flat()
      .filter((id): id is string => !!id)
      .filter((id, index, items) => items.indexOf(id) === index)
      .slice(0, 6)
    const body = {
      revision: state.revision,
      strategy: choice.strategy,
      mode,
      parentIDs: choice.parentIDs,
      inspirationIDs: choice.inspirationIDs,
      targetIsland: choice.targetIsland,
      contextIDs,
    }
    return { id: leaseID(state, body), ...body, reasons: choice.reasons }
  }

  function portfolio(state: State, count: number, start: number, openRoots: number) {
    const options = routes(state)
    return Array.from({ length: count }, (_, index) => {
      const selected = options[index % options.length]!
      const choice = selected.parentIDs.length
        ? selected
        : {
            ...selected,
            targetIsland: (selected.targetIsland + openRoots + index) % state.population.count,
            reasons: [...selected.reasons, `portfolio-root:${index}`],
          }
      return {
        recommendation: materialize(state, choice),
        mandate: mandate(choice.strategy, start + index),
      }
    })
  }

  export function recommend(state: State): Recommendation {
    const parsed = State.parse(state)
    return materialize(parsed, route(parsed))
  }
}
