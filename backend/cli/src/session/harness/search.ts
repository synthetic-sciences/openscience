import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"

export namespace HarnessSearch {
  export const Stop = z.enum(["budget_exhausted", "objective_met", "no_improvement", "user_cancelled", "runtime_error"])
  export type Stop = z.infer<typeof Stop>

  export const Artifact = z
    .object({
      uri: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
  export type Artifact = z.infer<typeof Artifact>

  export const Result = z
    .object({
      source: z.enum(["observed", "verified"]),
      status: HarnessEvaluation.Status,
      score: z.number().finite().optional(),
      metrics: z.record(z.string(), z.number().finite()).default({}),
      checks: z.array(HarnessEvaluation.Check).default([]),
      evidence: z.array(z.string().min(1)).default([]),
      feedback: z.string().optional(),
      evaluator: z.string().optional(),
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
      branch: z.string().min(1),
      generation: z.number().int().nonnegative(),
      proposal: z.string().min(1),
      artifact: Artifact,
      result: Result.optional(),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Candidate = z.infer<typeof Candidate>

  export const State = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      objective: z.string().min(1),
      evaluator: z.string().min(1),
      metric: z.string().min(1),
      direction: z.enum(["maximize", "minimize", "pass"]),
      target: z.number().finite().optional(),
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
      stalled: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      startedAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
  export type State = z.infer<typeof State>

  export type Recommendation = {
    strategy: "seed" | "explore" | "exploit" | "fuse"
    parentIDs: string[]
    reasons: string[]
  }

  const root = path.join(Global.Path.data, "harness", "search")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  const candidates = (state: State) => Object.values(state.candidates)
  const verified = (candidate: Candidate) =>
    candidate.result?.source === "verified" && candidate.result.status === "passed"

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

  const reached = (state: State, candidate: Candidate) => {
    if (!verified(candidate)) return false
    if (state.direction === "pass") return true
    if (state.target === undefined || candidate.result?.score === undefined) return false
    if (state.direction === "maximize") return candidate.result.score >= state.target
    return candidate.result.score <= state.target
  }

  const expired = (state: State, now: number) =>
    state.budget.wallTimeMs !== undefined && now - state.startedAt >= state.budget.wallTimeMs

  const stop = (state: State, reason: Stop, now = Date.now()): State => ({
    ...state,
    status: "completed",
    stopReason: reason,
    revision: state.revision + 1,
    updatedAt: now,
  })

  function parse(data: Record<string, unknown>) {
    return State.parse(data)
  }

  export async function initialize(input: {
    sessionID: string
    candidates: number
    wallTimeMs?: number
    stall?: number
    target?: number
  }) {
    const contract = await HarnessContract.read(input.sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${input.sessionID}`)
    if (contract.profile !== "optimize") throw new Error(`Harness search requires the optimize profile`)
    const now = Date.now()
    const initial: State = {
      schemaVersion: 1,
      runID: contract.runID,
      sessionID: input.sessionID,
      objective: contract.objective,
      evaluator: contract.benchmark.evaluator,
      metric: contract.benchmark.metric ?? "status",
      direction: contract.benchmark.direction ?? "pass",
      ...(input.target === undefined ? {} : { target: input.target }),
      budget: {
        candidates: input.candidates,
        ...(input.wallTimeMs === undefined ? {} : { wallTimeMs: input.wallTimeMs }),
        stall: input.stall ?? 5,
      },
      status: "active",
      candidates: {},
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
    branch: string
    proposal: string
    artifact: Artifact
  }) {
    const artifact = Artifact.parse(input.artifact)
    const parents = input.parentIDs.toSorted()
    const id = digest({
      parentIDs: parents,
      branch: input.branch,
      proposal: input.proposal,
      artifact,
    })
    const out = { accepted: false, id }
    await JsonStore.update(file(input.sessionID), (data) => {
      const state = parse(data)
      const existing = state.candidates[id]
      if (existing) {
        out.accepted = true
        return state
      }
      const now = Date.now()
      if (state.status !== "active") return state
      if (expired(state, now) || candidates(state).length >= state.budget.candidates) {
        return stop(state, "budget_exhausted", now)
      }
      if (parents.length > 2) throw new Error(`A candidate may have at most two parents`)
      if (new Set(parents).size !== parents.length) throw new Error(`Candidate parents must be unique`)
      const ancestors = parents.map((parent) => state.candidates[parent])
      if (ancestors.some((parent) => !parent)) throw new Error(`Every candidate parent must exist in the same search`)
      if (ancestors.some((parent) => !verified(parent!))) {
        throw new Error(`Candidates may only descend from externally verified passing parents`)
      }
      if (!parents.length && candidates(state).length) throw new Error(`Only the first candidate may be parentless`)
      const generation = ancestors.length ? Math.max(...ancestors.map((parent) => parent!.generation)) + 1 : 0
      const candidate: Candidate = Candidate.parse({
        id,
        parentIDs: parents,
        branch: input.branch,
        generation,
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
      if (candidate.result?.source === "verified")
        throw new Error(`A verified result cannot be replaced by an observation`)
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
    const evaluation = await HarnessEvaluation.read(input.sessionID)
    if (!evaluation) throw new Error(`No recorded external evaluation exists for session ${input.sessionID}`)
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
      const now = Date.now()
      const before = state.bestID
      const result = Result.parse({
        source: "verified",
        status: evaluation.status,
        score: evaluation.score,
        metrics: evaluation.metrics,
        checks: evaluation.checks,
        evidence: evaluation.evidence,
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
      const improved = best?.id === candidate.id && before !== candidate.id
      const next: State = {
        ...provisional,
        bestID: best?.id,
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
    if (!pool.length) return { strategy: "seed", parentIDs: [], reasons: ["no-verified-candidate"] }
    const distinct = pool.filter(
      (candidate, index) => pool.findIndex((item) => item.branch === candidate.branch) === index,
    )
    if (state.stalled >= state.budget.stall && distinct.length >= 2) {
      return {
        strategy: "fuse",
        parentIDs: distinct.slice(0, 2).map((candidate) => candidate.id),
        reasons: [`stalled:${state.stalled}`, "cross-branch-fusion"],
      }
    }
    const progress = candidates(state).length / state.budget.candidates
    if (progress >= 0.5) {
      return {
        strategy: "exploit",
        parentIDs: [pool[0]!.id],
        reasons: [`budget-progress:${progress.toFixed(2)}`, "verified-rank"],
      }
    }
    const counts = new Map<string, number>()
    for (const candidate of candidates(state)) counts.set(candidate.branch, (counts.get(candidate.branch) ?? 0) + 1)
    const diverse = distinct.toSorted(
      (a, b) => (counts.get(a.branch) ?? 0) - (counts.get(b.branch) ?? 0) || order(state, a, b),
    )
    return {
      strategy: "explore",
      parentIDs: [diverse[0]!.id],
      reasons: [`budget-progress:${progress.toFixed(2)}`, "underexplored-branches"],
    }
  }
}
