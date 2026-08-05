import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessEvolution } from "./evolution"

export namespace HarnessIntervention {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const Role = z.enum(["control", "arm"])
  const Status = z.enum(["passed", "failed", "inconclusive"])
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable)
    if (!input || typeof input !== "object") return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, stable(value)]),
    )
  }
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(stable(input))).digest("hex")
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  const Model = z
    .object({
      provider: z.string().min(1).max(200),
      name: z.string().min(1).max(500),
      version: z.string().min(1).max(200),
    })
    .strict()

  const Evaluator = z
    .object({
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
      source: z.enum(["benchmark", "gate", "external"]),
    })
    .strict()

  const Split = z
    .object({
      name: z.string().min(1).max(200),
      manifest: HarnessEvolution.Artifact,
    })
    .strict()

  export const Condition = z
    .object({
      seed: z.number().int(),
      model: Model,
      context: HarnessEvolution.Artifact,
      evaluator: Evaluator,
      split: Split,
      environment: HarnessEvolution.Artifact,
      budget: HarnessEvolution.Artifact,
    })
    .strict()
  export type Condition = z.infer<typeof Condition>

  export const Target = z
    .object({
      artifact: HarnessEvolution.Artifact,
      condition: Condition,
    })
    .strict()
  export type Target = z.infer<typeof Target>

  const PairInput = z
    .object({
      family: HarnessContract.InterventionFamily,
      index: z.number().int().nonnegative().max(31),
      control: Target,
      arm: Target,
      change: HarnessEvolution.Artifact,
    })
    .strict()

  export const Pair = PairInput.extend({ pairID: Hash }).strict()
  export type Pair = z.infer<typeof Pair>

  export const Validator = z
    .object({
      name: z.literal("design-replay-interventions"),
      version: z.literal(1),
      scriptSHA256: Hash,
    })
    .strict()

  export const Initialize = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      subject: HarnessEvolution.Subject,
      evolutionReceiptID: Hash,
      validator: Validator,
      pairs: z.array(PairInput).min(3).max(256),
    })
    .strict()
  export type Initialize = z.input<typeof Initialize>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()

  export const Observe = z
    .object({
      schemaVersion: z.literal(1),
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      pairID: Hash,
      role: Role,
      targetSHA256: Hash,
      status: Status,
      score: z.number().finite().optional(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.status !== "passed" || value.score !== undefined) return
      ctx.addIssue({ code: "custom", path: ["score"], message: "A passing intervention observation requires a score" })
    })
  export type Observe = z.input<typeof Observe>

  export const Plan = z
    .object({
      schemaVersion: z.literal(1),
      planID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      protocol: HarnessContract.Interventions,
      benchmark: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          taskID: z.string().min(1),
          metric: z.string().min(1),
          direction: z.enum(["maximize", "minimize"]),
        })
        .strict(),
      subject: HarnessEvolution.Subject,
      evolutionReceiptID: Hash,
      validator: Validator,
      pairs: z.array(Pair).min(3).max(256),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Plan = z.infer<typeof Plan>

  export const Outcome = z
    .object({
      schemaVersion: z.literal(1),
      outcomeID: Hash,
      submissionID: Hash,
      pairID: Hash,
      role: Role,
      targetSHA256: Hash,
      status: Status,
      score: z.number().finite().optional(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type Outcome = z.infer<typeof Outcome>

  const Family = z
    .object({
      family: HarnessContract.InterventionFamily,
      mode: z.enum(["max_absolute_effect", "min_effect", "max_regression"]),
      threshold: z.number().finite(),
      pairs: z.number().int().min(3).max(32),
      validPairs: z.number().int().nonnegative().max(32),
      meanEffect: z.number().finite().optional(),
      standardDeviation: z.number().finite().nonnegative().optional(),
      standardError: z.number().finite().nonnegative().optional(),
      confidence95: z.tuple([z.number().finite(), z.number().finite()]).optional(),
      maxAbsoluteEffect: z.number().finite().nonnegative().optional(),
      regressions: z.number().int().nonnegative(),
      verdict: Status,
    })
    .strict()

  export const Receipt = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      planID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      subject: HarnessEvolution.Subject,
      evolutionReceiptID: Hash,
      families: z.array(Family).min(1).max(HarnessContract.InterventionFamily.options.length),
      status: Status,
      observedAt: z.number().int().positive(),
      assessedAt: z.number().int().positive(),
    })
    .strict()
  export type Receipt = z.infer<typeof Receipt>

  const slot = (pairID: string, role: z.infer<typeof Role>) => `${pairID}:${role}`
  const find = (outcomes: Record<string, Outcome>, pairID: string, role: z.infer<typeof Role>) =>
    Object.values(outcomes).find((outcome) => outcome.pairID === pairID && outcome.role === role)
  const submission = (
    sessionID: string,
    candidateID: string,
    outcome: Pick<Outcome, "pairID" | "role" | "targetSHA256" | "status" | "score" | "evidence" | "evaluatedAt">,
  ) =>
    digest({
      schemaVersion: 1,
      sessionID,
      candidateID,
      pairID: outcome.pairID,
      role: outcome.role,
      targetSHA256: outcome.targetSHA256,
      status: outcome.status,
      score: outcome.score,
      evidence: outcome.evidence,
      evaluatedAt: outcome.evaluatedAt,
    })

  export const State = z
    .object({
      schemaVersion: z.literal(1),
      plan: Plan,
      outcomes: z.record(z.string(), Outcome),
      order: z.array(z.string()),
      receipt: Receipt.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const plan = structuredClone(value.plan) as Record<string, unknown>
      delete plan.planID
      if (digest(plan) !== value.plan.planID) {
        ctx.addIssue({ code: "custom", path: ["plan", "planID"], message: "Intervention plan content hash is invalid" })
      }
      try {
        validatePlan(value.plan)
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["plan"],
          message: error instanceof Error ? error.message : "Intervention plan is invalid",
        })
      }
      for (const pair of value.plan.pairs) {
        const payload = structuredClone(pair) as Record<string, unknown>
        delete payload.pairID
        if (digest(payload) !== pair.pairID) {
          ctx.addIssue({ code: "custom", path: ["plan", "pairs"], message: "Intervention pair hash is invalid" })
        }
        try {
          validatePair(value.plan.subject, pair)
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["plan", "pairs"],
            message: error instanceof Error ? error.message : "Intervention pair is invalid",
          })
        }
      }
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Intervention outcome order must be unique" })
      }
      const slots = new Set<string>()
      for (const id of value.order) {
        const outcome = value.outcomes[id]
        if (!outcome) {
          ctx.addIssue({ code: "custom", path: ["order"], message: `Intervention outcome ${id} is missing` })
          continue
        }
        if (outcome.outcomeID !== id) {
          ctx.addIssue({
            code: "custom",
            path: ["outcomes", id],
            message: "Intervention outcome key does not match its ID",
          })
        }
        const payload = structuredClone(outcome) as Record<string, unknown>
        delete payload.outcomeID
        if (digest(payload) !== id) {
          ctx.addIssue({ code: "custom", path: ["outcomes", id], message: "Intervention outcome hash is invalid" })
        }
        const key = slot(outcome.pairID, outcome.role)
        if (slots.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["outcomes", id],
            message: `Intervention outcome slot ${key} is duplicated`,
          })
        }
        slots.add(key)
        if (outcome.submissionID !== submission(value.plan.sessionID, value.plan.subject.id, outcome)) {
          ctx.addIssue({
            code: "custom",
            path: ["outcomes", id],
            message: "Intervention submission derivation is invalid",
          })
        }
        if (outcome.evaluatedAt < value.plan.createdAt || outcome.recordedAt < outcome.evaluatedAt) {
          ctx.addIssue({ code: "custom", path: ["outcomes", id], message: "Intervention outcome timing is invalid" })
        }
        const pair = value.plan.pairs.find((item) => item.pairID === outcome.pairID)
        const target = pair?.[outcome.role]
        if (!target || digest(target) !== outcome.targetSHA256) {
          ctx.addIssue({
            code: "custom",
            path: ["outcomes", id],
            message: "Intervention outcome does not match its frozen target",
          })
        }
      }
      for (const id of Object.keys(value.outcomes)) {
        if (value.order.includes(id)) continue
        ctx.addIssue({
          code: "custom",
          path: ["outcomes", id],
          message: "Intervention outcome is absent from journal order",
        })
      }
      if (!value.receipt) return
      const receipt = structuredClone(value.receipt) as Record<string, unknown>
      delete receipt.receiptID
      if (digest(receipt) !== value.receipt.receiptID) {
        ctx.addIssue({ code: "custom", path: ["receipt"], message: "Intervention receipt content hash is invalid" })
      }
      if (
        value.receipt.planID !== value.plan.planID ||
        value.receipt.runID !== value.plan.runID ||
        value.receipt.sessionID !== value.plan.sessionID ||
        value.receipt.contractFingerprint !== value.plan.contractFingerprint ||
        !same(value.receipt.subject, value.plan.subject) ||
        value.receipt.evolutionReceiptID !== value.plan.evolutionReceiptID
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["receipt"],
          message: "Intervention receipt does not match its frozen plan",
        })
      }
      const expected = value.plan.pairs.flatMap((pair) => [slot(pair.pairID, "control"), slot(pair.pairID, "arm")])
      if (expected.length !== slots.size || !expected.every((item) => slots.has(item))) {
        ctx.addIssue({
          code: "custom",
          path: ["receipt"],
          message: "Intervention receipt requires every frozen outcome",
        })
      }
      const observedAt = Math.max(...Object.values(value.outcomes).map((outcome) => outcome.evaluatedAt))
      const recordedAt = Math.max(...Object.values(value.outcomes).map((outcome) => outcome.recordedAt))
      if (value.receipt.observedAt !== observedAt || value.receipt.assessedAt < recordedAt) {
        ctx.addIssue({ code: "custom", path: ["receipt"], message: "Intervention receipt timing is invalid" })
      }
      const derived = derive(value.plan, value.outcomes)
      if (!same(value.receipt.families, derived.families) || value.receipt.status !== derived.status) {
        ctx.addIssue({ code: "custom", path: ["receipt"], message: "Intervention assessment derivation drifted" })
      }
    })
  export type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "interventions")
  const file = (sessionID: string, candidateID: string) =>
    path.join(root, encodeURIComponent(sessionID), `${Hash.parse(candidateID)}.json`)

  function changed(left: Target, right: Target) {
    const fields = ["artifact", "model", "context", "evaluator", "split", "environment", "budget", "seed"] as const
    return fields.filter((field) => {
      if (field === "artifact") return !same(left.artifact, right.artifact)
      if (field === "seed") return left.condition.seed !== right.condition.seed
      return !same(left.condition[field], right.condition[field])
    })
  }

  function validatePair(subject: z.infer<typeof HarnessEvolution.Subject>, input: z.infer<typeof PairInput>) {
    const payload = structuredClone(input) as Record<string, unknown>
    delete payload.pairID
    const pair = PairInput.parse(payload)
    const changes = changed(pair.control, pair.arm)
    const subjectArtifact = subject.artifact
    if (pair.family === "replay") {
      if (changes.length) throw new Error(`Replay pairs must repeat the exact same target and condition`)
      if (!same(pair.arm.artifact, subjectArtifact)) throw new Error(`Replay pairs must evaluate the study subject`)
      return
    }
    if (["retune", "ablation", "repair"].includes(pair.family)) {
      if (!same(changes, ["artifact"])) {
        throw new Error(`${pair.family} pairs may change only the exact subject artifact`)
      }
      if (!same(pair.arm.artifact, subjectArtifact)) {
        throw new Error(`${pair.family} pair arms must be the study subject`)
      }
      return
    }
    const expected = `${pair.family.replace("_transfer", "")}` as (typeof changes)[number]
    if (!same(changes, [expected])) throw new Error(`${pair.family} pairs may change only ${expected}`)
    if (!same(pair.control.artifact, subjectArtifact) || !same(pair.arm.artifact, subjectArtifact)) {
      throw new Error(`${pair.family} pairs must evaluate the same study subject`)
    }
  }

  function validatePlan(plan: Plan) {
    if (plan.validator.scriptSHA256 !== plan.protocol.validatorSHA256) {
      throw new Error(`Intervention validator does not match its frozen protocol`)
    }
    if (new Set(plan.pairs.map((pair) => pair.pairID)).size !== plan.pairs.length) {
      throw new Error(`Intervention pairs must be unique`)
    }
    const families = [...new Set(plan.pairs.map((pair) => pair.family))].toSorted()
    if (!same(families, plan.protocol.required)) {
      throw new Error(`Intervention pairs must cover exactly the required families`)
    }
    for (const family of plan.protocol.required) {
      const pairs = plan.pairs.filter((pair) => pair.family === family)
      if (pairs.length < plan.protocol.minPairs || pairs.length > plan.protocol.maxPairs) {
        throw new Error(`Intervention family ${family} violates its frozen pair bounds`)
      }
      if (
        !same(
          pairs.map((pair) => pair.index),
          pairs.map((_, index) => index),
        )
      ) {
        throw new Error(`Intervention family ${family} pair indexes must be contiguous from zero`)
      }
    }
    if (plan.pairs.length > plan.protocol.maxTotalPairs)
      throw new Error(`Intervention plan exceeds its total pair limit`)
  }

  function match(plan: Plan, contract: HarnessContract.Info, candidateID: string) {
    const expected = {
      name: contract.benchmark.name,
      version: contract.benchmark.version,
      taskID: contract.benchmark.taskID,
      metric: contract.benchmark.metric,
      direction: contract.benchmark.direction,
    }
    if (
      plan.runID !== contract.runID ||
      plan.sessionID !== contract.sessionID ||
      plan.contractFingerprint !== HarnessContract.fingerprint(contract) ||
      !same(plan.protocol, contract.interventions) ||
      !same(plan.benchmark, expected)
    ) {
      throw new Error(`Intervention plan does not match the immutable harness contract`)
    }
    if (plan.subject.id !== candidateID) throw new Error(`Intervention plan does not match the candidate`)
  }

  function critical(pairs: number) {
    const values = [
      0, 0, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
      2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042, 2.04,
    ]
    return values[Math.min(31, pairs - 1)]!
  }

  function statistics(plan: Plan, family: HarnessContract.InterventionFamily, outcomes: Record<string, Outcome>) {
    const pairs = plan.pairs.filter((pair) => pair.family === family)
    const effects = pairs.flatMap((pair) => {
      const control = find(outcomes, pair.pairID, "control")
      const arm = find(outcomes, pair.pairID, "arm")
      if (!control || !arm || control.status !== "passed" || arm.status !== "passed") return []
      if (control.score === undefined || arm.score === undefined) return []
      return [plan.benchmark.direction === "maximize" ? arm.score - control.score : control.score - arm.score]
    })
    const mean = effects.length ? effects.reduce((sum, effect) => sum + effect, 0) / effects.length : undefined
    const variance =
      mean === undefined || effects.length < 2
        ? undefined
        : effects.reduce((sum, effect) => sum + (effect - mean) ** 2, 0) / (effects.length - 1)
    const deviation = variance === undefined ? undefined : Math.sqrt(variance)
    const error = deviation === undefined ? undefined : deviation / Math.sqrt(effects.length)
    const interval =
      mean === undefined || error === undefined
        ? undefined
        : ([mean - critical(effects.length) * error, mean + critical(effects.length) * error] as const)
    const maximum = effects.length ? Math.max(...effects.map(Math.abs)) : undefined
    const regressions = effects.filter((effect) => effect < 0).length
    const rule = plan.protocol.rules.find((item) => item.family === family)!
    const complete = effects.length === pairs.length
    const verdict = (() => {
      if (!complete) return "failed" as const
      if (rule.mode === "max_absolute_effect")
        return maximum! <= rule.threshold ? ("passed" as const) : ("failed" as const)
      if (rule.mode === "min_effect") {
        if (!regressions && mean! > rule.threshold && interval![0] > rule.threshold) return "passed" as const
        if (regressions || interval![1] <= rule.threshold) return "failed" as const
        return "inconclusive" as const
      }
      if (effects.some((effect) => effect < -rule.threshold)) return "failed" as const
      if (interval![0] >= -rule.threshold) return "passed" as const
      return "inconclusive" as const
    })()
    return Family.parse({
      family,
      mode: rule.mode,
      threshold: rule.threshold,
      pairs: pairs.length,
      validPairs: effects.length,
      meanEffect: mean,
      standardDeviation: deviation,
      standardError: error,
      confidence95: interval,
      maxAbsoluteEffect: maximum,
      regressions,
      verdict,
    })
  }

  function derive(plan: Plan, outcomes: Record<string, Outcome>) {
    const families = plan.protocol.required.map((family) => statistics(plan, family, outcomes))
    const status = families.some((family) => family.verdict === "failed")
      ? ("failed" as const)
      : families.some((family) => family.verdict === "inconclusive")
        ? ("inconclusive" as const)
        : ("passed" as const)
    return { families, status }
  }

  export async function initialize(input: Initialize, contract: HarnessContract.Info) {
    const value = Initialize.parse(input)
    const bound = HarnessContract.Info.parse(contract)
    const protocol = bound.interventions
    if (!protocol) throw new Error(`No intervention protocol is bound to session ${value.sessionID}`)
    if (bound.sessionID !== value.sessionID || bound.runID !== value.runID) {
      throw new Error(`Intervention plan does not match the bound harness run`)
    }
    if (value.validator.scriptSHA256 !== protocol.validatorSHA256) {
      throw new Error(`Intervention validator does not match the immutable harness contract`)
    }
    const frozenAt = Date.now()
    const trace = await HarnessEvolution.assert({
      contract: bound,
      receiptID: value.evolutionReceiptID,
      candidateID: value.subject.id,
      evaluatedAt: frozenAt,
      recordedAt: frozenAt,
    })
    if (!same(trace.subject.artifact, value.subject.artifact)) {
      throw new Error(`Intervention subject artifact does not match its evolution receipt`)
    }
    const search = await import("./search").then((module) => module.HarnessSearch.read(value.sessionID))
    const candidate = search.candidates[value.subject.id]
    if (!candidate || !same(candidate.artifact, value.subject.artifact)) {
      throw new Error(`Intervention subject does not match a candidate in the bound search`)
    }
    const evaluations = await import("./evaluation").then((module) => module.HarnessEvaluation.list(value.sessionID))
    if (
      evaluations.some(
        (evaluation) =>
          evaluation.subject?.type === "candidate" &&
          evaluation.subject.id === value.subject.id &&
          evaluation.fidelity?.final !== false,
      )
    ) {
      throw new Error(`Intervention plan must be frozen before the candidate's final evaluation`)
    }
    const pairs = value.pairs
      .map((pair) => {
        validatePair(value.subject, pair)
        return Pair.parse({ ...pair, pairID: digest(pair) })
      })
      .toSorted((left, right) => left.family.localeCompare(right.family) || left.index - right.index)
    const payload = {
      schemaVersion: 1 as const,
      runID: value.runID,
      sessionID: value.sessionID,
      contractFingerprint: HarnessContract.fingerprint(bound),
      protocol,
      benchmark: {
        name: bound.benchmark.name,
        version: bound.benchmark.version,
        taskID: bound.benchmark.taskID,
        metric: bound.benchmark.metric!,
        direction: bound.benchmark.direction as "maximize" | "minimize",
      },
      subject: value.subject,
      evolutionReceiptID: value.evolutionReceiptID,
      validator: value.validator,
      pairs,
      createdAt: frozenAt,
    }
    const plan = Plan.parse({ ...payload, planID: digest(payload) })
    validatePlan(plan)
    const expected = State.parse({ schemaVersion: 1, plan, outcomes: {}, order: [] })
    await JsonStore.update(file(value.sessionID, value.subject.id), (data) => {
      if (!Object.keys(data).length) return expected
      const current = State.parse(data)
      if (current.plan.planID === plan.planID) return current
      throw new Error(`Intervention plan is immutable once initialized`)
    })
    const current = await read(value.sessionID, value.subject.id)
    if (!current) throw new Error(`Intervention plan was corrupt after initialization`)
    match(current.plan, bound, value.subject.id)
    return current
  }

  export async function read(sessionID: string, candidateID: string) {
    const data = await JsonStore.read(file(sessionID, candidateID))
    const parsed = State.safeParse(data)
    return parsed.success ? parsed.data : null
  }

  export async function status(sessionID: string, candidateID: string, contract: HarnessContract.Info) {
    const state = await read(sessionID, candidateID)
    if (!state) return null
    match(state.plan, contract, candidateID)
    return state
  }

  export async function observe(candidateID: string, input: Observe, contract: HarnessContract.Info) {
    const value = Observe.parse(input)
    const bound = HarnessContract.Info.parse(contract)
    if (bound.sessionID !== value.sessionID) throw new Error(`Intervention observation belongs to another session`)
    const target = file(value.sessionID, candidateID)
    const output: { value?: Outcome } = {}
    await JsonStore.update(target, (data) => {
      const current = State.parse(data)
      match(current.plan, bound, candidateID)
      if (current.receipt) throw new Error(`Intervention study is closed after assessment`)
      const pair = current.plan.pairs.find((item) => item.pairID === value.pairID)
      if (!pair) throw new Error(`Intervention pair ${value.pairID} is not in the frozen plan`)
      if (digest(pair[value.role]) !== value.targetSHA256) {
        throw new Error(`Intervention observation target does not match the frozen pair`)
      }
      if (value.evaluatedAt < current.plan.createdAt) {
        throw new Error(`Intervention observation predates its frozen plan`)
      }
      if (value.evaluatedAt > Date.now()) throw new Error(`Intervention observation is future-dated`)
      const evidence = value.evidence.toSorted()
      const submissionID = submission(value.sessionID, candidateID, {
        pairID: value.pairID,
        role: value.role,
        targetSHA256: value.targetSHA256,
        status: value.status,
        score: value.score,
        evidence,
        evaluatedAt: value.evaluatedAt,
      })
      const key = slot(value.pairID, value.role)
      const prior = Object.values(current.outcomes).find((outcome) => slot(outcome.pairID, outcome.role) === key)
      if (prior) {
        if (prior.submissionID !== submissionID)
          throw new Error(`Intervention outcome ${key} is immutable once recorded`)
        output.value = prior
        return current
      }
      const recordedAt = Date.now()
      const payload = {
        schemaVersion: 1 as const,
        submissionID,
        pairID: value.pairID,
        role: value.role,
        targetSHA256: value.targetSHA256,
        status: value.status,
        score: value.score,
        evidence,
        evaluatedAt: value.evaluatedAt,
        recordedAt,
      }
      const outcome = Outcome.parse({ ...payload, outcomeID: digest(payload) })
      output.value = outcome
      return State.parse({
        ...current,
        outcomes: { ...current.outcomes, [outcome.outcomeID]: outcome },
        order: [...current.order, outcome.outcomeID],
      })
    })
    if (!output.value) throw new Error(`Intervention outcome was not durable after recording`)
    return output.value
  }

  export async function assess(sessionID: string, candidateID: string, contract: HarnessContract.Info) {
    const bound = HarnessContract.Info.parse(contract)
    if (bound.sessionID !== sessionID) throw new Error(`Intervention assessment belongs to another session`)
    const target = file(sessionID, candidateID)
    const output: { value?: Receipt } = {}
    await JsonStore.update(target, (data) => {
      const current = State.parse(data)
      match(current.plan, bound, candidateID)
      if (current.receipt) {
        output.value = current.receipt
        return current
      }
      const expected = current.plan.pairs.flatMap((pair) => [slot(pair.pairID, "control"), slot(pair.pairID, "arm")])
      const observed = Object.values(current.outcomes).map((outcome) => slot(outcome.pairID, outcome.role))
      if (!expected.every((item) => observed.includes(item)) || observed.length !== expected.length) {
        throw new Error(`Intervention assessment requires every frozen pair outcome`)
      }
      const derived = derive(current.plan, current.outcomes)
      const observedAt = Math.max(...Object.values(current.outcomes).map((outcome) => outcome.evaluatedAt))
      const assessedAt = Date.now()
      if (assessedAt < Math.max(...Object.values(current.outcomes).map((outcome) => outcome.recordedAt))) {
        throw new Error(`Intervention assessment predates one of its observations`)
      }
      const payload = {
        schemaVersion: 1 as const,
        planID: current.plan.planID,
        runID: current.plan.runID,
        sessionID: current.plan.sessionID,
        contractFingerprint: current.plan.contractFingerprint,
        subject: current.plan.subject,
        evolutionReceiptID: current.plan.evolutionReceiptID,
        families: derived.families,
        status: derived.status,
        observedAt,
        assessedAt,
      }
      const receipt = Receipt.parse({ ...payload, receiptID: digest(payload) })
      output.value = receipt
      return State.parse({ ...current, receipt })
    })
    if (!output.value) throw new Error(`Intervention receipt was not durable after assessment`)
    return output.value
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    candidateID: string
    evolutionReceiptID: string
    requirePassed: boolean
    evaluatedAt: number
    recordedAt: number
  }) {
    const state = await read(input.contract.sessionID, input.candidateID)
    const receipt = state?.receipt
    if (!receipt || receipt.receiptID !== Hash.parse(input.receiptID)) {
      throw new Error(`Unknown or corrupt controlled intervention receipt ${input.receiptID}`)
    }
    if (receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract)) {
      throw new Error(`Intervention receipt does not match the immutable harness contract`)
    }
    if (receipt.subject.id !== input.candidateID) {
      throw new Error(`Intervention receipt does not match the evaluated candidate`)
    }
    match(state.plan, input.contract, input.candidateID)
    if (receipt.evolutionReceiptID !== Hash.parse(input.evolutionReceiptID)) {
      throw new Error(`Intervention receipt does not match the evaluation's evolution receipt`)
    }
    if (receipt.observedAt > input.evaluatedAt) {
      throw new Error(`Final benchmark evaluation predates its controlled intervention observations`)
    }
    if (receipt.assessedAt > input.recordedAt) {
      throw new Error(`Final benchmark evaluation was recorded before its intervention assessment`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A passing final evaluation requires a passing controlled intervention receipt`)
    }
    return receipt
  }
}
