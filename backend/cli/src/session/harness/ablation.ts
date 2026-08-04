import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessAdapter } from "./adapter"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"
import { HarnessSearch } from "./search"

export namespace HarnessAblation {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  export const Factor = z
    .object({
      kind: z.enum([
        "profile",
        "orchestration",
        "audit",
        "simulation",
        "evaluator_audit",
        "fidelities",
        "skill",
        "tool",
      ]),
      name: z.string().min(1).max(200).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const named = value.kind === "skill" || value.kind === "tool"
      if (named && !value.name) {
        ctx.addIssue({ code: "custom", path: ["name"], message: `${value.kind} ablations require a name` })
      }
      if (!named && value.name) {
        ctx.addIssue({ code: "custom", path: ["name"], message: `${value.kind} ablations cannot name a subfactor` })
      }
    })
  export type Factor = z.infer<typeof Factor>

  const Ref = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()

  export const Initialize = z
    .object({
      schemaVersion: z.literal(1),
      studyID: z.string().min(1).max(240),
      factor: Factor,
      minEffect: z.number().finite().nonnegative(),
      maxPairRegression: z.number().finite().nonnegative().default(0),
      pairs: z
        .array(z.object({ baseline: Ref, arm: Ref }).strict())
        .min(3)
        .max(32),
    })
    .strict()
  export type Initialize = z.input<typeof Initialize>

  const Run = z
    .object({
      sessionID: z.string().min(1).max(240),
      runID: z.string().min(1).max(240),
      contractFingerprint: Hash,
    })
    .strict()

  export const Plan = z
    .object({
      schemaVersion: z.literal(1),
      planID: Hash,
      studyID: z.string().min(1).max(240),
      factor: Factor,
      baselineValueSHA256: Hash,
      armValueSHA256: Hash,
      contextSHA256: Hash,
      benchmark: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          taskID: z.string().min(1),
          split: z.enum(["held_out", "release"]),
          evaluator: z.string().min(1),
          evaluatorVersion: z.string().min(1),
          metric: z.string().min(1),
          direction: z.enum(["maximize", "minimize"]),
        })
        .strict(),
      minEffect: z.number().finite().nonnegative(),
      maxPairRegression: z.number().finite().nonnegative(),
      pairs: z
        .array(
          z
            .object({
              seed: z.number().int(),
              baseline: Run,
              arm: Run,
            })
            .strict(),
        )
        .min(3)
        .max(32),
      createdAt: z.number().int().positive(),
    })
    .strict()
  export type Plan = z.infer<typeof Plan>

  export const Assess = z
    .object({
      runs: z
        .array(Ref)
        .min(6)
        .max(64)
        .refine(
          (items) => new Set(items.map((item) => item.sessionID)).size === items.length,
          "Run credentials must be unique",
        ),
    })
    .strict()
  export type Assess = z.input<typeof Assess>

  const Outcome = z
    .object({
      sessionID: z.string().min(1),
      runID: z.string().min(1),
      status: HarnessEvaluation.Status,
      score: z.number().finite().optional(),
      evaluationSHA256: Hash,
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()

  export const Receipt = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      planID: Hash,
      studyID: z.string().min(1),
      factor: Factor,
      pairs: z
        .array(
          z
            .object({
              seed: z.number().int(),
              baseline: Outcome,
              arm: Outcome,
              effect: z.number().finite().optional(),
            })
            .strict(),
        )
        .min(3)
        .max(32),
      statistics: z
        .object({
          pairs: z.number().int().min(3),
          validPairs: z.number().int().nonnegative(),
          meanEffect: z.number().finite().optional(),
          standardDeviation: z.number().finite().nonnegative().optional(),
          standardError: z.number().finite().nonnegative().optional(),
          confidence95: z.tuple([z.number().finite(), z.number().finite()]).optional(),
          regressions: z.number().int().nonnegative(),
          minEffect: z.number().finite().nonnegative(),
          maxPairRegression: z.number().finite().nonnegative(),
        })
        .strict(),
      verdict: z.enum(["supported", "rejected", "inconclusive"]),
      assessedAt: z.number().int().positive(),
    })
    .strict()
  export type Receipt = z.infer<typeof Receipt>

  export const State = z
    .object({
      schemaVersion: z.literal(1),
      plan: Plan,
      receipt: Receipt.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const payload = structuredClone(value.plan) as Record<string, unknown>
      delete payload.planID
      if (digest(payload) !== value.plan.planID) {
        ctx.addIssue({ code: "custom", path: ["plan", "planID"], message: "Ablation plan content hash is invalid" })
      }
      if (!value.receipt) return
      if (value.receipt.planID !== value.plan.planID) {
        ctx.addIssue({ code: "custom", path: ["receipt", "planID"], message: "Ablation receipt targets another plan" })
      }
      const receipt = structuredClone(value.receipt) as Record<string, unknown>
      delete receipt.receiptID
      delete receipt.assessedAt
      if (digest(receipt) !== value.receipt.receiptID) {
        ctx.addIssue({
          code: "custom",
          path: ["receipt", "receiptID"],
          message: "Ablation receipt content hash is invalid",
        })
      }
    })
  export type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "ablations")
  const file = (planID: string) => path.join(root, `${planID}.json`)

  function value(contract: HarnessContract.Info, factor: Factor) {
    if (factor.kind === "profile") return contract.profile
    if (factor.kind === "orchestration") return contract.orchestration ?? null
    if (factor.kind === "audit") return contract.audit ?? null
    if (factor.kind === "simulation") return contract.simulation ?? null
    if (factor.kind === "evaluator_audit") return contract.evaluatorAudit ?? null
    if (factor.kind === "fidelities") return contract.benchmark.fidelities ?? null
    if (factor.kind === "skill") return contract.skills.find((item) => item.name === factor.name) ?? null
    return contract.tools.includes(factor.name!)
  }

  function context(contract: HarnessContract.Info, factor: Factor, seed: boolean) {
    const benchmark = {
      name: contract.benchmark.name,
      version: contract.benchmark.version,
      taskID: contract.benchmark.taskID,
      split: contract.benchmark.split,
      evaluator: contract.benchmark.evaluator,
      evaluatorVersion: contract.benchmark.evaluatorVersion,
      evaluatorSource: contract.benchmark.evaluatorSource,
      ...(factor.kind === "fidelities" ? {} : { fidelities: contract.benchmark.fidelities }),
      metric: contract.benchmark.metric,
      direction: contract.benchmark.direction,
      target: contract.benchmark.target,
    }
    return {
      objective: contract.objective,
      benchmark,
      ...(factor.kind === "profile" ? {} : { profile: contract.profile }),
      ...(factor.kind === "orchestration" ? {} : { orchestration: contract.orchestration }),
      ...(factor.kind === "audit" ? {} : { audit: contract.audit }),
      ...(factor.kind === "simulation" ? {} : { simulation: contract.simulation }),
      ...(factor.kind === "evaluator_audit" ? {} : { evaluatorAudit: contract.evaluatorAudit }),
      packs: (contract.packs ?? []).toSorted(),
      model: contract.model,
      tools: contract.tools.filter((item) => factor.kind !== "tool" || item !== factor.name).toSorted(),
      skills: contract.skills
        .filter((item) => factor.kind !== "skill" || item.name !== factor.name)
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      budget: contract.budget,
      ...(seed ? { seed: contract.seed } : {}),
      intervention: contract.intervention,
      contamination: contract.contamination,
    }
  }

  function validate(left: HarnessContract.Info, right: HarnessContract.Info, factor: Factor) {
    if (left.sessionID === right.sessionID || left.runID === right.runID) {
      throw new Error(`Ablation baseline and arm must be separate runs`)
    }
    if (left.seed !== right.seed) throw new Error(`Ablation pairs must use the same seed`)
    if (!same(context(left, factor, true), context(right, factor, true))) {
      throw new Error(`Ablation pair differs outside the declared factor`)
    }
    const baseline = value(left, factor)
    const arm = value(right, factor)
    if (same(baseline, arm)) throw new Error(`Ablation factor does not change between baseline and arm`)
    return { baseline: digest(baseline), arm: digest(arm) }
  }

  export async function initialize(input: Initialize) {
    const value = Initialize.parse(input)
    const frozenAt = Date.now()
    const pairs = await Promise.all(
      value.pairs.map(async (pair) => {
        const [baseline, arm] = await Promise.all([
          HarnessAdapter.authorize(pair.baseline.sessionID, pair.baseline.evaluatorToken),
          HarnessAdapter.authorize(pair.arm.sessionID, pair.arm.evaluatorToken),
        ])
        const factor = validate(baseline, arm, value.factor)
        return { baseline, arm, factor }
      }),
    )
    const seeds = pairs.map((pair) => pair.baseline.seed)
    if (new Set(seeds).size !== seeds.length) throw new Error(`Ablation pairs require distinct seeds`)
    const sessions = pairs.flatMap((pair) => [pair.baseline.sessionID, pair.arm.sessionID])
    if (new Set(sessions).size !== sessions.length) throw new Error(`Ablation runs cannot be reused across pairs`)
    const histories = await Promise.all(sessions.map((sessionID) => HarnessEvaluation.list(sessionID)))
    if (histories.some((items) => items.length)) {
      throw new Error(`Ablation plans must be frozen before any paired evaluation is recorded`)
    }
    const first = pairs[0]!
    if (first.baseline.benchmark.split !== "held_out" && first.baseline.benchmark.split !== "release") {
      throw new Error(`Ablation evidence requires a held-out or release split`)
    }
    if (first.baseline.benchmark.direction === "pass" || !first.baseline.benchmark.direction) {
      throw new Error(`Ablation evidence requires a numeric benchmark direction`)
    }
    if (!first.baseline.benchmark.metric || !first.baseline.benchmark.evaluatorVersion) {
      throw new Error(`Ablation evidence requires a bound metric and evaluator version`)
    }
    if (pairs.some((pair) => pair.factor.baseline !== first.factor.baseline || pair.factor.arm !== first.factor.arm)) {
      throw new Error(`Every ablation pair must use the same baseline and arm factor values`)
    }
    const contexts = pairs.map((pair) => digest(context(pair.baseline, value.factor, false)))
    if (new Set(contexts).size !== 1) throw new Error(`Ablation pairs differ outside their seeds`)
    if (pairs.some((pair) => frozenAt < pair.baseline.createdAt || frozenAt < pair.arm.createdAt)) {
      throw new Error(`Ablation plan predates one of its bound run contracts`)
    }
    const payload = {
      schemaVersion: 1 as const,
      studyID: value.studyID,
      factor: value.factor,
      baselineValueSHA256: first.factor.baseline,
      armValueSHA256: first.factor.arm,
      contextSHA256: contexts[0]!,
      benchmark: {
        name: first.baseline.benchmark.name,
        version: first.baseline.benchmark.version,
        taskID: first.baseline.benchmark.taskID,
        split: first.baseline.benchmark.split as "held_out" | "release",
        evaluator: first.baseline.benchmark.evaluator,
        evaluatorVersion: first.baseline.benchmark.evaluatorVersion,
        metric: first.baseline.benchmark.metric,
        direction: first.baseline.benchmark.direction,
      },
      minEffect: value.minEffect,
      maxPairRegression: value.maxPairRegression,
      pairs: pairs.map((pair) => ({
        seed: pair.baseline.seed,
        baseline: {
          sessionID: pair.baseline.sessionID,
          runID: pair.baseline.runID,
          contractFingerprint: HarnessContract.fingerprint(pair.baseline),
        },
        arm: {
          sessionID: pair.arm.sessionID,
          runID: pair.arm.runID,
          contractFingerprint: HarnessContract.fingerprint(pair.arm),
        },
      })),
      createdAt: frozenAt,
    }
    const plan = Plan.parse({ ...payload, planID: digest(payload) })
    const expected = State.parse({ schemaVersion: 1, plan })
    await JsonStore.update(file(plan.planID), (data) => {
      if (!Object.keys(data).length) return expected
      const current = State.parse(data)
      if (current.plan.planID === plan.planID) return current
      throw new Error(`Ablation plan is immutable once initialized`)
    })
    return read(plan.planID)
  }

  export async function read(planID: string) {
    const data = await JsonStore.read(file(Hash.parse(planID)))
    const parsed = State.safeParse(data)
    return parsed.success ? parsed.data : null
  }

  async function outcome(sessionID: string) {
    const evaluations = await HarnessEvaluation.list(sessionID)
    const search = await HarnessSearch.read(sessionID).catch(() => undefined)
    const candidate = search?.bestID
      ? evaluations.findLast(
          (item) =>
            item.subject?.type === "candidate" && item.subject.id === search.bestID && HarnessEvaluation.final(item),
        )
      : undefined
    return (
      candidate ??
      evaluations.findLast((item) => !item.subject && HarnessEvaluation.final(item)) ??
      evaluations.findLast(HarnessEvaluation.final)
    )
  }

  function critical(pairs: number) {
    const values = [
      0, 0, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
      2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042, 2.04,
    ]
    return values[Math.min(31, pairs - 1)]!
  }

  export async function assess(planID: string, input: Assess) {
    const value = Assess.parse(input)
    const id = Hash.parse(planID)
    const state = await read(id)
    if (!state) throw new Error(`Unknown ablation plan ${id}`)
    const expected = state.plan.pairs.flatMap((pair) => [pair.baseline.sessionID, pair.arm.sessionID]).toSorted()
    const supplied = value.runs.map((run) => run.sessionID).toSorted()
    if (!same(expected, supplied)) throw new Error(`Assessment credentials do not match every planned run`)
    const tokens = new Map(value.runs.map((run) => [run.sessionID, run.evaluatorToken]))
    const contracts = new Map(
      await Promise.all(
        expected.map(async (sessionID) => {
          const contract = await HarnessAdapter.authorize(sessionID, tokens.get(sessionID)!)
          return [sessionID, contract] as const
        }),
      ),
    )
    for (const pair of state.plan.pairs) {
      for (const run of [pair.baseline, pair.arm]) {
        const contract = contracts.get(run.sessionID)!
        if (HarnessContract.fingerprint(contract) !== run.contractFingerprint) {
          throw new Error(`Ablation run contract changed after planning`)
        }
      }
    }
    const pairs = await Promise.all(
      state.plan.pairs.map(async (pair) => {
        const [baseline, arm] = await Promise.all([outcome(pair.baseline.sessionID), outcome(pair.arm.sessionID)])
        if (!baseline || !arm) throw new Error(`Every planned ablation run requires a final external evaluation`)
        if (!baseline.recordedAt || !arm.recordedAt) {
          throw new Error(`Ablation evidence requires server-timestamped evaluation receipts`)
        }
        if (baseline.recordedAt < state.plan.createdAt || arm.recordedAt < state.plan.createdAt) {
          throw new Error(`Ablation evaluation was received before its plan was frozen`)
        }
        const valid =
          HarnessEvaluation.verified(baseline) &&
          HarnessEvaluation.verified(arm) &&
          baseline.score !== undefined &&
          arm.score !== undefined
        const effect = valid
          ? state.plan.benchmark.direction === "maximize"
            ? arm.score! - baseline.score!
            : baseline.score! - arm.score!
          : undefined
        return {
          seed: pair.seed,
          baseline: {
            sessionID: pair.baseline.sessionID,
            runID: pair.baseline.runID,
            status: baseline.status,
            score: baseline.score,
            evaluationSHA256: HarnessEvaluation.fingerprint(baseline),
            evaluatedAt: baseline.evaluatedAt,
            recordedAt: baseline.recordedAt,
          },
          arm: {
            sessionID: pair.arm.sessionID,
            runID: pair.arm.runID,
            status: arm.status,
            score: arm.score,
            evaluationSHA256: HarnessEvaluation.fingerprint(arm),
            evaluatedAt: arm.evaluatedAt,
            recordedAt: arm.recordedAt,
          },
          effect,
        }
      }),
    )
    const effects = pairs.flatMap((pair) => (pair.effect === undefined ? [] : [pair.effect]))
    const mean = effects.length ? effects.reduce((sum, item) => sum + item, 0) / effects.length : undefined
    const variance =
      mean === undefined || effects.length < 2
        ? undefined
        : effects.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (effects.length - 1)
    const deviation = variance === undefined ? undefined : Math.sqrt(variance)
    const error = deviation === undefined ? undefined : deviation / Math.sqrt(effects.length)
    const interval =
      mean === undefined || error === undefined
        ? undefined
        : ([mean - critical(effects.length) * error, mean + critical(effects.length) * error] as const)
    const regressions = effects.filter((effect) => effect < -state.plan.maxPairRegression).length
    const complete = effects.length === pairs.length
    const assessedAt = Date.now()
    if (assessedAt < Math.max(...pairs.flatMap((pair) => [pair.baseline.recordedAt, pair.arm.recordedAt]))) {
      throw new Error(`Ablation assessment predates one of its paired evaluations`)
    }
    const verdict = (() => {
      if (!complete || regressions) return "rejected" as const
      if (mean! > state.plan.minEffect && interval![0] > state.plan.minEffect) return "supported" as const
      if (interval![1] <= state.plan.minEffect) return "rejected" as const
      return "inconclusive" as const
    })()
    const stable = {
      schemaVersion: 1 as const,
      planID: state.plan.planID,
      studyID: state.plan.studyID,
      factor: state.plan.factor,
      pairs,
      statistics: {
        pairs: pairs.length,
        validPairs: effects.length,
        meanEffect: mean,
        standardDeviation: deviation,
        standardError: error,
        confidence95: interval,
        regressions,
        minEffect: state.plan.minEffect,
        maxPairRegression: state.plan.maxPairRegression,
      },
      verdict,
    }
    const receipt = Receipt.parse({
      ...stable,
      receiptID: digest(stable),
      assessedAt,
    })
    await JsonStore.update(file(state.plan.planID), (data) => {
      const current = State.parse(data)
      if (!current.receipt) return State.parse({ ...current, receipt })
      if (current.receipt.receiptID === receipt.receiptID) return current
      throw new Error(`Ablation assessment is immutable once recorded`)
    })
    return read(state.plan.planID)
  }
}
