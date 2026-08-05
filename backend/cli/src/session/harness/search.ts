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
      result: Result.optional(),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Candidate = z.infer<typeof Candidate>

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
      schemaVersion: z.literal(2),
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

  export type Recommendation = {
    strategy: "seed" | "explore" | "exploit" | "fuse" | "migrate" | "diverge"
    parentIDs: string[]
    inspirationIDs: string[]
    targetIsland: number
    reasons: string[]
  }

  const root = path.join(Global.Path.data, "harness", "search")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  const candidates = (state: State) => Object.values(state.candidates)
  const verified = (candidate: Candidate) =>
    candidate.result?.source === "verified" && candidate.result.status === "passed"

  const identity = (input: Pick<Candidate, "parentIDs" | "inspirationIDs" | "branch" | "proposal" | "artifact">) =>
    digest({
      parentIDs: input.parentIDs.toSorted(),
      inspirationIDs: input.inspirationIDs.toSorted(),
      branch: input.branch,
      proposal: input.proposal,
      artifact: input.artifact,
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
    revision: state.revision + 1,
    updatedAt: now,
  })

  function topology(state: State) {
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
      const least = Math.min(...counts)
      const expected = parents.length
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
  }

  function parse(data: Record<string, unknown>) {
    const migrated =
      data.schemaVersion === 1
        ? {
            ...data,
            schemaVersion: 2,
            population: { mode: "legacy", count: 1, topology: "ring", migrationInterval: 1 },
          }
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
      schemaVersion: 2,
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

  export async function add(input: {
    sessionID: string
    parentIDs: string[]
    inspirationIDs?: string[]
    branch: string
    proposal: string
    artifact: Artifact
  }) {
    const artifact = Artifact.parse(input.artifact)
    const parents = input.parentIDs.toSorted()
    const inspirations = (input.inspirationIDs ?? []).toSorted()
    const id = identity({
      parentIDs: parents,
      inspirationIDs: inspirations,
      branch: input.branch,
      proposal: input.proposal,
      artifact,
    })
    const out = { accepted: false, deduplicated: false, id }
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const existing = candidates(state).find((candidate) => candidate.artifact.sha256 === artifact.sha256)
      if (existing) {
        out.accepted = true
        out.deduplicated = true
        out.id = existing.id
        return state
      }
      const now = Date.now()
      if (state.status !== "active") return state
      if (expired(state, now) || candidates(state).length >= state.budget.candidates) {
        return stop(state, "budget_exhausted", now)
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
      if (!parents.length && candidates(state).length) {
        const roots = candidates(state).filter(
          (candidate) =>
            !candidate.parentIDs.length &&
            (candidate.result === undefined ||
              (candidate.result.source === "verified" && candidate.result.status === "passed")),
        )
        const limit = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(state.budget.candidates))))
        if (roots.length >= limit) throw new Error(`Independent candidate root budget is exhausted`)
        if (roots.some((candidate) => candidate.branch === input.branch)) {
          throw new Error(`An active independent root already exists for branch ${input.branch}`)
        }
      }
      const generation = ancestors.length ? Math.max(...ancestors.map((parent) => parent!.generation)) + 1 : 0
      const island = ancestors.length ? ancestors.toSorted((a, b) => order(state, a!, b!))[0]!.island : vacancy(state)
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
        createdAt: now,
      })
      out.accepted = true
      return {
        ...state,
        candidates: { ...state.candidates, [id]: candidate },
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

  export function recommend(state: State): Recommendation {
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
}
