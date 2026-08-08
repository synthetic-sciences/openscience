import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessAdapter } from "./adapter"
import { HarnessContract } from "./contract"
import { HarnessSearch } from "./search"

export namespace HarnessAudit {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  export const Subject = z
    .object({
      type: z.enum(["run", "candidate"]),
      id: z.string().min(1).max(500),
      artifactSHA256: Hash,
    })
    .strict()
  export type Subject = z.infer<typeof Subject>

  export const Probe = z
    .object({
      id: z.string().min(1).max(240),
      commitment: Hash,
      features: z.array(z.number().finite()).min(1).max(32),
      stratum: z.string().min(1).max(120),
      weight: z.number().positive().max(1_000).default(1),
      priorLoss: z.number().min(0).max(1).default(0.5),
    })
    .strict()
  export type Probe = z.infer<typeof Probe>

  export const TransferProbe = z
    .object({
      id: z.string().min(1).max(240),
      commitment: Hash,
      sourceLosses: z.array(z.number().min(0).max(1)).min(3).max(64),
      stratum: z.string().min(1).max(120),
      weight: z.number().positive().max(1_000).default(1),
    })
    .strict()
  export type TransferProbe = z.infer<typeof TransferProbe>

  const InputProbe = z.union([Probe, TransferProbe])

  export const Selection = z
    .object({
      round: z.number().int().positive(),
      selectedAt: z.number().int().positive(),
      phase: z.enum(["calibration", "adaptive", "fallback"]).optional(),
      acquisition: z
        .object({
          posteriorLoss: z.number().min(0).max(1),
          posteriorStd: z.number().nonnegative(),
          failureUCB: z.number().min(0).max(1),
          varianceReduction: z.number().nonnegative(),
          diversity: z.number().min(0).max(1),
          coverage: z.number().min(0).max(1),
          score: z.number().finite(),
        })
        .strict(),
    })
    .strict()
  export type Selection = z.infer<typeof Selection>

  export const Observation = z
    .object({
      loss: z.number().min(0).max(1),
      failure: z.boolean(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
      note: z.string().max(4_000).optional(),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Observation = z.infer<typeof Observation>

  export const Entry = Probe.extend({
    features: z.array(z.number().finite()).min(1).max(64),
    sourceLosses: z.array(z.number().min(0).max(1)).min(3).max(64).optional(),
    selection: Selection.optional(),
    observation: Observation.optional(),
  })
    .strict()
    .superRefine((value, ctx) => {
      if (value.observation && !value.selection) {
        ctx.addIssue({ code: "custom", path: ["observation"], message: "An observation requires a selection" })
      }
    })
  export type Entry = z.infer<typeof Entry>

  export const Transfer = z
    .object({
      status: z.enum(["not_configured", "calibrating", "accepted", "rejected"]),
      observed: z.number().int().nonnegative(),
      required: z.number().int().nonnegative(),
      meanAbsoluteError: z.number().min(0).max(1).optional(),
      threshold: z.number().positive().max(1).optional(),
    })
    .strict()
  export type Transfer = z.infer<typeof Transfer>

  export const Estimate = z
    .object({
      observed: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
      meanLoss: z.number().min(0).max(1),
      standardDeviation: z.number().nonnegative(),
      lower95: z.number().min(0).max(1),
      upper95: z.number().min(0).max(1),
      abstain: z.boolean(),
      effectivePoolSize: z.number().positive(),
      stratumCoverage: z.number().min(0).max(1),
      transfer: Transfer.default({ status: "not_configured", observed: 0, required: 0 }),
    })
    .strict()
  export type Estimate = z.infer<typeof Estimate>

  export const Stop = z.enum(["budget_exhausted", "precision_reached", "failure_target_reached", "pool_exhausted"])
  export type Stop = z.infer<typeof Stop>

  export const State = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.enum(["active-audit-v1", "proactive-audit-v2"]),
      auditID: Hash,
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      evaluator: z.string().min(1),
      contractFingerprint: Hash,
      poolFingerprint: Hash,
      subject: Subject,
      config: HarnessContract.Audit,
      status: z.enum(["active", "completed"]),
      stopReason: Stop.optional(),
      pool: z.record(z.string(), Entry),
      order: z.array(z.string().min(1)),
      estimate: Estimate,
      revision: z.number().int().nonnegative(),
      createdAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length || value.order.length !== Object.keys(value.pool).length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Audit order must exactly cover a unique probe pool" })
      }
      const dimensions = new Set(value.order.map((id) => value.pool[id]?.features.length))
      if (dimensions.size !== 1) {
        ctx.addIssue({ code: "custom", path: ["pool"], message: "Audit probe features must share one dimension" })
      }
      const commitments = value.order.flatMap((id) => (value.pool[id] ? [value.pool[id]!.commitment] : []))
      if (new Set(commitments).size !== commitments.length) {
        ctx.addIssue({ code: "custom", path: ["pool"], message: "Audit probe commitments must be unique" })
      }
      const selections = value.order.flatMap((id) => {
        const selection = value.pool[id]?.selection
        return selection ? [selection.round] : []
      })
      if (new Set(selections).size !== selections.length) {
        ctx.addIssue({ code: "custom", path: ["pool"], message: "Audit selection rounds must be unique" })
      }
      const pending = value.order.filter((id) => value.pool[id]?.selection && !value.pool[id]?.observation)
      if (pending.length > 1) {
        ctx.addIssue({ code: "custom", path: ["pool"], message: "Only one audit probe may be pending" })
      }
      for (const id of value.order) {
        if (value.pool[id]) continue
        ctx.addIssue({ code: "custom", path: ["pool", id], message: "Audit probe is missing" })
      }
      const expected = value.config.transfer ? "proactive-audit-v2" : "active-audit-v1"
      if (value.protocolVersion !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["protocolVersion"],
          message: "Audit protocol does not match its contract",
        })
      }
      for (const id of value.order) {
        const entry = value.pool[id]
        if (!entry) continue
        if (!value.config.transfer && !entry.sourceLosses) continue
        if (!value.config.transfer || !entry.sourceLosses) {
          ctx.addIssue({ code: "custom", path: ["pool", id], message: "Audit transfer probe shape is inconsistent" })
          continue
        }
        if (entry.sourceLosses.length !== value.config.transfer.sourceModels.length) {
          ctx.addIssue({
            code: "custom",
            path: ["pool", id, "sourceLosses"],
            message: "Audit source-loss dimension does not match the frozen source models",
          })
          continue
        }
        const priorLoss = entry.sourceLosses.reduce((sum, loss) => sum + loss, 0) / entry.sourceLosses.length
        const features = entry.sourceLosses.map(
          (loss) => (loss - priorLoss) / Math.sqrt(Math.max(entry.sourceLosses!.length - 1, 1)),
        )
        if (entry.priorLoss !== priorLoss || JSON.stringify(entry.features) !== JSON.stringify(features)) {
          ctx.addIssue({
            code: "custom",
            path: ["pool", id],
            message: "Audit score-history prior was not derived by the backend",
          })
        }
      }
    })
  export type State = z.infer<typeof State>

  const ReceiptBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("proactive-audit-receipt-v1"),
      receiptID: Hash,
      auditID: Hash,
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      contractFingerprint: Hash,
      poolFingerprint: Hash,
      subject: Subject,
      config: HarnessContract.Audit,
      stopReason: Stop,
      estimate: Estimate,
      revision: z.number().int().positive(),
      qualified: z.boolean(),
      completedAt: z.number().int().positive(),
      sealedAt: z.number().int().positive(),
    })
    .strict()

  export const Receipt = ReceiptBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.receiptID
    if (digest(stable) !== value.receiptID) {
      ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Active audit receipt content hash is invalid" })
    }
    const qualified =
      value.config.mode !== "failure" && value.estimate.transfer.status === "accepted" && !value.estimate.abstain
    if (value.qualified !== qualified) {
      ctx.addIssue({ code: "custom", path: ["qualified"], message: "Active audit receipt qualification drifted" })
    }
    if (value.completedAt > value.sealedAt) {
      ctx.addIssue({ code: "custom", path: ["sealedAt"], message: "Active audit receipt predates completion" })
    }
    const auditID = digest({
      contractFingerprint: value.contractFingerprint,
      subject: value.subject,
      poolFingerprint: value.poolFingerprint,
      config: value.config,
    })
    if (value.auditID !== auditID) {
      ctx.addIssue({ code: "custom", path: ["auditID"], message: "Active audit receipt identity is invalid" })
    }
  })
  export type Receipt = z.infer<typeof Receipt>

  export const Initialize = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: z.string().min(32).max(1_024),
      subject: Subject,
      probes: z.array(InputProbe).min(2).max(2_000),
    })
    .strict()
  export type Initialize = z.input<typeof Initialize>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: z.string().min(32).max(1_024),
    })
    .strict()
  export type Access = z.infer<typeof Access>

  export const Observe = Access.extend({
    probeID: z.string().min(1).max(240),
    loss: z.number().min(0).max(1),
    failure: z.boolean(),
    evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    note: z.string().max(4_000).optional(),
  }).strict()
  export type Observe = z.infer<typeof Observe>

  const root = path.join(Global.Path.data, "harness", "audits")
  const receipts = path.join(Global.Path.data, "harness", "audit-receipts")
  const bases = new Map<string, { matrix: number[][]; features: number[][]; weights: number[]; meanKernel: number[] }>()
  const file = (sessionID: string, auditID: string) =>
    path.join(root, encodeURIComponent(sessionID), `${encodeURIComponent(auditID)}.json`)
  const receiptFile = (receiptID: string) => path.join(receipts, `${receiptID}.json`)
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  const dot = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index]!, 0)
  const kernel = (left: number[], right: number[], lengthscale: number) =>
    Math.exp(
      -left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0) / (2 * lengthscale * lengthscale),
    )

  function derive(probe: TransferProbe): Entry {
    const priorLoss = probe.sourceLosses.reduce((sum, loss) => sum + loss, 0) / probe.sourceLosses.length
    const features = probe.sourceLosses.map(
      (loss) => (loss - priorLoss) / Math.sqrt(Math.max(probe.sourceLosses.length - 1, 1)),
    )
    return Entry.parse({ ...probe, features, priorLoss })
  }

  function committed(entry: Entry, transfer: boolean) {
    if (transfer) {
      return TransferProbe.parse({
        id: entry.id,
        commitment: entry.commitment,
        sourceLosses: entry.sourceLosses,
        stratum: entry.stratum,
        weight: entry.weight,
      })
    }
    return Probe.parse({
      id: entry.id,
      commitment: entry.commitment,
      features: entry.features,
      stratum: entry.stratum,
      weight: entry.weight,
      priorLoss: entry.priorLoss,
    })
  }

  function drift(state: State) {
    const probes = state.order.map((id) => committed(state.pool[id]!, Boolean(state.config.transfer)))
    if (digest(probes) !== state.poolFingerprint) return `Active audit probe pool failed its commitment`
    const auditID = digest({
      contractFingerprint: state.contractFingerprint,
      subject: state.subject,
      poolFingerprint: state.poolFingerprint,
      config: state.config,
    })
    if (auditID !== state.auditID) return `Active audit identity failed its commitment`
    if (JSON.stringify(state.estimate) !== JSON.stringify(summarize(state))) {
      return `Active audit estimate does not match its backend-derived posterior`
    }
  }

  function parse(input: Record<string, unknown>) {
    const state = State.parse(input)
    const error = drift(state)
    if (error) throw new Error(error)
    return state
  }

  function match(state: State, contract: HarnessContract.Info) {
    if (state.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Active audit does not match the bound harness contract`)
    }
    if (state.evaluator !== contract.benchmark.evaluator) {
      throw new Error(`Active audit evaluator does not match the bound harness contract`)
    }
  }

  function cholesky(matrix: number[][]) {
    const output = matrix.map((row) => row.map(() => 0))
    for (const i of matrix.keys()) {
      for (const j of matrix.keys()) {
        if (j > i) break
        const sum = output[i]!.slice(0, j).reduce((total, value, index) => total + value * output[j]![index]!, 0)
        const value =
          i === j ? Math.sqrt(Math.max(matrix[i]![i]! - sum, 1e-12)) : (matrix[i]![j]! - sum) / output[j]![j]!
        if (!Number.isFinite(value)) throw new Error(`Audit kernel is not numerically stable`)
        output[i]![j] = value
      }
    }
    return output
  }

  function forward(matrix: number[][], target: number[]) {
    const output: number[] = []
    for (const i of target.keys()) {
      const sum = matrix[i]!.slice(0, i).reduce((total, value, index) => total + value * output[index]!, 0)
      output.push((target[i]! - sum) / matrix[i]![i]!)
    }
    return output
  }

  function solve(matrix: number[][], target: number[]) {
    const lower = forward(matrix, target)
    const output = target.map(() => 0)
    for (const i of [...target.keys()].toReversed()) {
      const sum = target
        .slice(i + 1)
        .reduce((total, _, offset) => total + matrix[i + offset + 1]![i]! * output[i + offset + 1]!, 0)
      output[i] = (lower[i]! - sum) / matrix[i]![i]!
    }
    return output
  }

  function scale(entries: Entry[]) {
    const dimensions = entries[0]!.features.map((_, index) => {
      const values = entries.map((entry) => entry.features[index]!)
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
      return { mean, standardDeviation: Math.sqrt(variance) || 1 }
    })
    return entries.map((entry) =>
      entry.features.map((value, index) => (value - dimensions[index]!.mean) / dimensions[index]!.standardDeviation),
    )
  }

  function basis(state: State, entries: Entry[]) {
    const key = `${state.protocolVersion}:${state.poolFingerprint}:${state.config.lengthscale}`
    const cached = bases.get(key)
    if (cached) return cached
    const features = state.config.transfer ? entries.map((entry) => entry.features) : scale(entries)
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
    const weights = entries.map((entry) => entry.weight / total)
    const matrix = features.map((left) =>
      features.map((right) =>
        state.config.transfer ? dot(left, right) : kernel(left, right, state.config.lengthscale),
      ),
    )
    const meanKernel = matrix.map((row) => row.reduce((sum, value, index) => sum + weights[index]! * value, 0))
    const value = { matrix, features, weights, meanKernel }
    if (bases.size >= 4) {
      const oldest = bases.keys().next().value
      if (oldest) bases.delete(oldest)
    }
    bases.set(key, value)
    return value
  }

  function posterior(state: State) {
    const entries = state.order.map((id) => state.pool[id]!)
    const base = basis(state, entries)
    const observed = entries.flatMap((entry, index) => (entry.observation ? [index] : []))
    const matrix = observed.map((left, i) =>
      observed.map((right, j) => base.matrix[left]![right]! + (i === j ? state.config.noiseVariance : 0)),
    )
    const factor = matrix.length ? cholesky(matrix) : []
    const residual = observed.map((index) => entries[index]!.observation!.loss - entries[index]!.priorLoss)
    const alpha = factor.length ? solve(factor, residual) : []
    const weightedObserved = observed.map((index) => base.meanKernel[index]!)
    const weightedProjection = factor.length ? forward(factor, weightedObserved) : []
    const probes = entries.map((entry, index) => {
      const cross = observed.map((peer) => base.matrix[index]![peer]!)
      const projection = factor.length ? forward(factor, cross) : []
      const mean = clamp(entry.priorLoss + dot(cross, alpha))
      const variance = Math.max(base.matrix[index]![index]! - dot(projection, projection), 1e-12)
      const covariance = base.meanKernel[index]! - dot(projection, weightedProjection)
      return {
        mean,
        variance,
        varianceReduction: Math.max((covariance * covariance) / (variance + state.config.noiseVariance), 0),
      }
    })
    const priorVariance = base.weights.reduce((sum, weight, index) => sum + weight * base.meanKernel[index]!, 0)
    const integralVariance = Math.max(priorVariance - dot(weightedProjection, weightedProjection), 0)
    return { entries, weights: base.weights, features: base.features, observed, probes, integralVariance }
  }

  function transfer(state: State): Transfer {
    const protocol = state.config.transfer
    if (!protocol) return { status: "not_configured", observed: 0, required: 0 }
    const samples = state.order
      .map((id) => state.pool[id]!)
      .filter((entry) => entry.selection && entry.selection.round <= protocol.calibrationSamples && entry.observation)
    const meanAbsoluteError = samples.length
      ? samples.reduce((sum, entry) => sum + Math.abs(entry.observation!.loss - entry.priorLoss), 0) / samples.length
      : undefined
    const status =
      samples.length < protocol.calibrationSamples
        ? ("calibrating" as const)
        : meanAbsoluteError! <= protocol.maxCalibrationMAE
          ? ("accepted" as const)
          : ("rejected" as const)
    return Transfer.parse({
      status,
      observed: samples.length,
      required: protocol.calibrationSamples,
      meanAbsoluteError,
      threshold: protocol.maxCalibrationMAE,
    })
  }

  function summarize(state: State): Estimate {
    const model = posterior(state)
    const qualification = transfer(state)
    const meanLoss = clamp(model.probes.reduce((sum, probe, index) => sum + model.weights[index]! * probe.mean, 0))
    const standardDeviation = Math.sqrt(model.integralVariance)
    const strata = new Set(model.entries.map((entry) => entry.stratum))
    const covered = new Set(model.entries.filter((entry) => entry.observation).map((entry) => entry.stratum))
    const denominator = model.weights.reduce((sum, weight) => sum + weight * weight, 0)
    return Estimate.parse({
      observed: model.observed.length,
      failures: model.entries.filter((entry) => entry.observation?.failure).length,
      meanLoss,
      standardDeviation,
      lower95: clamp(meanLoss - 1.96 * standardDeviation),
      upper95: clamp(meanLoss + 1.96 * standardDeviation),
      abstain:
        model.observed.length < state.config.minSamples ||
        standardDeviation > state.config.maxUncertainty ||
        (Boolean(state.config.transfer) && qualification.status !== "accepted"),
      effectivePoolSize: 1 / denominator,
      stratumCoverage: covered.size / strata.size,
      transfer: qualification,
    })
  }

  function distance(index: number, failures: number[], features: number[][]) {
    if (!failures.length) return 1
    const nearest = Math.min(
      ...failures.map((failure) =>
        Math.sqrt(
          features[index]!.reduce((sum, value, dimension) => sum + (value - features[failure]![dimension]!) ** 2, 0) /
            features[index]!.length,
        ),
      ),
    )
    return clamp(nearest)
  }

  function choose(state: State) {
    const model = posterior(state)
    const qualification = transfer(state)
    const candidates = model.entries.flatMap((entry, index) => (entry.selection ? [] : [{ entry, index }]))
    if (!candidates.length) throw new Error(`Audit probe pool is exhausted`)
    const reductions = candidates.map((candidate) => model.probes[candidate.index]!.varianceReduction)
    const low = Math.min(...reductions)
    const high = Math.max(...reductions)
    const maximumVariance = Math.max(...candidates.map((candidate) => model.probes[candidate.index]!.variance))
    const failures = model.entries.flatMap((entry, index) => (entry.observation?.failure ? [index] : []))
    const counts: Record<string, number> = {}
    for (const entry of model.entries) {
      if (!entry.observation) continue
      counts[entry.stratum] = (counts[entry.stratum] ?? 0) + 1
    }
    const weighted = candidates.map((candidate) => {
      const probe = model.probes[candidate.index]!
      const posteriorStd = Math.sqrt(probe.variance)
      const failureUCB = clamp(probe.mean + state.config.beta * posteriorStd)
      const eligible = failureUCB >= state.config.failureThreshold
      const potential = state.config.transfer
        ? eligible
          ? probe.variance / Math.max(maximumVariance, 1e-12)
          : 0
        : clamp((failureUCB - state.config.failureThreshold) / Math.max(1 - state.config.failureThreshold, 1e-9))
      const diversity = distance(candidate.index, failures, model.features)
      const coverage = 1 / Math.sqrt((counts[candidate.entry.stratum] ?? 0) + 1)
      const variance = high === low ? 1 : (probe.varianceReduction - low) / (high - low)
      const failure =
        state.config.transfer && !eligible
          ? 0
          : (1 - state.config.diversityWeight - state.config.coverageWeight) * potential +
            state.config.diversityWeight * diversity +
            state.config.coverageWeight * coverage
      const score =
        state.config.mode === "performance"
          ? variance
          : state.config.mode === "failure"
            ? failure
            : state.config.estimationWeight * variance + (1 - state.config.estimationWeight) * failure
      return {
        id: candidate.entry.id,
        acquisition: {
          posteriorLoss: probe.mean,
          posteriorStd,
          failureUCB,
          varianceReduction: probe.varianceReduction,
          diversity,
          coverage,
          score,
        },
      }
    })
    if (state.config.transfer && qualification.status !== "accepted") {
      const phase = qualification.status === "calibrating" ? ("calibration" as const) : ("fallback" as const)
      const selected = weighted.toSorted((left, right) => {
        const leftEntry = state.pool[left.id]!
        const rightEntry = state.pool[right.id]!
        const leftKey = digest([state.config.transfer!.selectionSHA256, leftEntry.commitment, left.id])
        const rightKey = digest([state.config.transfer!.selectionSHA256, rightEntry.commitment, right.id])
        return leftKey.localeCompare(rightKey) || left.id.localeCompare(right.id)
      })[0]!
      return { ...selected, phase }
    }
    const selected = weighted.toSorted(
      (left, right) => right.acquisition.score - left.acquisition.score || left.id.localeCompare(right.id),
    )[0]!
    return { ...selected, phase: "adaptive" as const }
  }

  function finish(state: State, now: number): State {
    const estimate = summarize(state)
    const reason = (() => {
      if (state.config.targetFailures !== undefined && estimate.failures >= state.config.targetFailures) {
        return "failure_target_reached" as const
      }
      if (estimate.observed >= state.config.budget) return "budget_exhausted" as const
      if (estimate.observed >= state.order.length) return "pool_exhausted" as const
      if (
        state.config.mode !== "failure" &&
        estimate.observed >= state.config.minSamples &&
        !estimate.abstain &&
        estimate.standardDeviation <= state.config.tolerance
      ) {
        return "precision_reached" as const
      }
    })()
    return State.parse({
      ...state,
      estimate,
      status: reason ? "completed" : "active",
      stopReason: reason,
      updatedAt: now,
    })
  }

  async function verify(contract: HarnessContract.Info, subject: Subject) {
    if (subject.type === "run") {
      if (subject.id !== contract.runID) throw new Error(`Audit run subject does not match the bound contract`)
      return
    }
    const search = await HarnessSearch.read(contract.sessionID)
    const candidate = search.candidates[subject.id]
    if (!candidate) throw new Error(`Audit candidate does not exist in the bound search`)
    if (candidate.artifact.sha256 !== subject.artifactSHA256) {
      throw new Error(`Audit artifact commitment does not match the candidate`)
    }
  }

  export async function initialize(input: Initialize) {
    const parsed = Initialize.parse(input)
    const contract = await HarnessAdapter.authorize(parsed.sessionID, parsed.evaluatorToken)
    if (!contract.audit) throw new Error(`The bound harness contract does not declare an active audit`)
    if (parsed.probes.length < contract.audit.budget) throw new Error(`Audit pool is smaller than the contract budget`)
    await verify(contract, parsed.subject)
    const source = parsed.probes.toSorted((left, right) => left.id.localeCompare(right.id))
    const probes = source.map((probe) => (contract.audit!.transfer ? TransferProbe.parse(probe) : Probe.parse(probe)))
    if (new Set(probes.map((probe) => probe.id)).size !== probes.length)
      throw new Error(`Audit probe ids must be unique`)
    if (contract.audit.transfer) {
      const invalid = probes.find(
        (probe) => TransferProbe.parse(probe).sourceLosses.length !== contract.audit!.transfer!.sourceModels.length,
      )
      if (invalid) throw new Error(`Audit source-loss dimension does not match the frozen source models`)
    }
    const poolFingerprint = digest(probes)
    if (contract.audit.transfer && poolFingerprint !== contract.audit.transfer.poolSHA256) {
      throw new Error(`Audit probe pool does not match the frozen transfer-pool commitment`)
    }
    if (contract.audit.transfer) {
      const sourceManifestSHA256 = digest({
        sourceModels: contract.audit.transfer.sourceModels,
        scores: probes.map((probe) => {
          const transfer = TransferProbe.parse(probe)
          return { id: transfer.id, sourceLosses: transfer.sourceLosses }
        }),
      })
      if (sourceManifestSHA256 !== contract.audit.transfer.sourceManifestSHA256) {
        throw new Error(`Audit source scores do not match the frozen source manifest`)
      }
    }
    const auditID = digest({
      contractFingerprint: HarnessContract.fingerprint(contract),
      subject: parsed.subject,
      poolFingerprint,
      config: contract.audit,
    })
    const entries = probes.map((probe) =>
      contract.audit!.transfer ? derive(TransferProbe.parse(probe)) : Entry.parse(Probe.parse(probe)),
    )
    const pool = Object.fromEntries(entries.map((probe) => [probe.id, probe]))
    const now = Date.now()
    const base = {
      schemaVersion: 1 as const,
      protocolVersion: contract.audit.transfer ? ("proactive-audit-v2" as const) : ("active-audit-v1" as const),
      auditID,
      runID: contract.runID,
      sessionID: contract.sessionID,
      evaluator: contract.benchmark.evaluator,
      contractFingerprint: HarnessContract.fingerprint(contract),
      poolFingerprint,
      subject: parsed.subject,
      config: contract.audit,
      status: "active" as const,
      pool,
      order: entries.map((probe) => probe.id),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }
    const initial = State.parse({
      ...base,
      estimate: summarize(State.parse({ ...base, estimate: seed(entries, contract.audit) })),
    })
    await JsonStore.update(file(parsed.sessionID, auditID), (data) => {
      if (!Object.keys(data).length) return initial
      const current = parse(data)
      if (current.poolFingerprint === poolFingerprint && current.contractFingerprint === base.contractFingerprint) {
        return current
      }
      throw new Error(`Active audit already exists with different immutable inputs`)
    })
    return read(parsed.sessionID, auditID)
  }

  function seed(probes: Entry[], config: HarnessContract.Audit): Estimate {
    const total = probes.reduce((sum, probe) => sum + probe.weight, 0)
    const weights = probes.map((probe) => probe.weight / total)
    const meanLoss = clamp(probes.reduce((sum, probe, index) => sum + weights[index]! * probe.priorLoss, 0))
    const denominator = weights.reduce((sum, weight) => sum + weight * weight, 0)
    return Estimate.parse({
      observed: 0,
      failures: 0,
      meanLoss,
      standardDeviation: 1,
      lower95: 0,
      upper95: 1,
      abstain: true,
      effectivePoolSize: 1 / denominator,
      stratumCoverage: 0,
      transfer: config.transfer
        ? {
            status: "calibrating",
            observed: 0,
            required: config.transfer.calibrationSamples,
            threshold: config.transfer.maxCalibrationMAE,
          }
        : { status: "not_configured", observed: 0, required: 0 },
    })
  }

  export async function read(sessionID: string, auditID: string) {
    return parse(await JsonStore.read(file(sessionID, auditID)))
  }

  export async function status(auditID: string, input: Access) {
    const access = Access.parse(input)
    const contract = await HarnessAdapter.authorize(access.sessionID, access.evaluatorToken)
    const state = await read(access.sessionID, auditID)
    match(state, contract)
    return state
  }

  export async function select(auditID: string, input: Access) {
    const access = Access.parse(input)
    const contract = await HarnessAdapter.authorize(access.sessionID, access.evaluatorToken)
    await JsonStore.update(file(access.sessionID, auditID), (data) => {
      const state = parse(data)
      match(state, contract)
      if (state.status !== "active") throw new Error(`Active audit is already completed`)
      const pending = state.order.find((id) => state.pool[id]!.selection && !state.pool[id]!.observation)
      if (pending) return state
      const selected = choose(state)
      const now = Date.now()
      return State.parse({
        ...state,
        pool: {
          ...state.pool,
          [selected.id]: {
            ...state.pool[selected.id]!,
            selection: {
              round: state.estimate.observed + 1,
              selectedAt: now,
              phase: selected.phase,
              acquisition: selected.acquisition,
            },
          },
        },
        revision: state.revision + 1,
        updatedAt: now,
      })
    })
    const state = await read(access.sessionID, auditID)
    const selected = state.order.find((id) => state.pool[id]!.selection && !state.pool[id]!.observation)!
    const entry = state.pool[selected]!
    return {
      auditID: state.auditID,
      probeID: entry.id,
      commitment: entry.commitment,
      round: entry.selection!.round,
      phase: entry.selection!.phase ?? "adaptive",
      acquisition: entry.selection!.acquisition,
      revision: state.revision,
    }
  }

  export async function observe(auditID: string, input: Observe) {
    const observation = Observe.parse(input)
    const contract = await HarnessAdapter.authorize(observation.sessionID, observation.evaluatorToken)
    await JsonStore.update(file(observation.sessionID, auditID), (data) => {
      const state = parse(data)
      match(state, contract)
      const entry = state.pool[observation.probeID]
      if (!entry) throw new Error(`Unknown audit probe ${observation.probeID}`)
      if (!entry.selection) throw new Error(`Audit probe must be selected before observation`)
      if (observation.failure !== observation.loss >= state.config.failureThreshold) {
        throw new Error(`Audit failure label does not match the contract threshold`)
      }
      const result = Observation.parse({
        loss: observation.loss,
        failure: observation.failure,
        evidence: observation.evidence,
        note: observation.note,
        evaluatedAt: Date.now(),
      })
      if (entry.observation) {
        const previous = { ...entry.observation, evaluatedAt: result.evaluatedAt }
        if (JSON.stringify(previous) === JSON.stringify(result)) return state
        throw new Error(`Audit probe observation is immutable`)
      }
      const now = result.evaluatedAt
      const next = State.parse({
        ...state,
        pool: { ...state.pool, [entry.id]: { ...entry, observation: result } },
        revision: state.revision + 1,
        updatedAt: now,
      })
      return finish(next, now)
    })
    return read(observation.sessionID, auditID)
  }

  export async function seal(auditID: string, input: Access) {
    const access = Access.parse(input)
    const contract = await HarnessAdapter.authorize(access.sessionID, access.evaluatorToken)
    const state = await read(access.sessionID, auditID)
    match(state, contract)
    if (state.status !== "completed" || !state.stopReason) {
      throw new Error(`Active audit must reach a terminal state before sealing`)
    }
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "proactive-audit-receipt-v1" as const,
      auditID: state.auditID,
      runID: state.runID,
      sessionID: state.sessionID,
      contractFingerprint: state.contractFingerprint,
      poolFingerprint: state.poolFingerprint,
      subject: state.subject,
      config: state.config,
      stopReason: state.stopReason,
      estimate: state.estimate,
      revision: state.revision,
      qualified:
        state.config.mode !== "failure" && state.estimate.transfer.status === "accepted" && !state.estimate.abstain,
      completedAt: state.updatedAt,
      sealedAt: state.updatedAt,
    }
    const receipt = Receipt.parse({ ...stable, receiptID: digest(stable) })
    await JsonStore.update(receiptFile(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Active audit receipt is immutable once recorded`)
    })
    const saved = await readReceipt(receipt.receiptID)
    if (!saved) throw new Error(`Active audit receipt was not durable after recording`)
    return saved
  }

  export async function readReceipt(receiptID: string) {
    const id = Hash.parse(receiptID)
    const parsed = Receipt.safeParse(await JsonStore.read(receiptFile(id)))
    if (!parsed.success || parsed.data.receiptID !== id) return null
    const data = await JsonStore.read(file(parsed.data.sessionID, parsed.data.auditID))
    const parsedState = State.safeParse(data)
    if (!parsedState.success || drift(parsedState.data)) return null
    const state = parsedState.data
    const snapshot = {
      auditID: state.auditID,
      runID: state.runID,
      sessionID: state.sessionID,
      contractFingerprint: state.contractFingerprint,
      poolFingerprint: state.poolFingerprint,
      subject: state.subject,
      config: state.config,
      stopReason: state.stopReason,
      estimate: state.estimate,
      revision: state.revision,
      completedAt: state.updatedAt,
    }
    const receipt = {
      auditID: parsed.data.auditID,
      runID: parsed.data.runID,
      sessionID: parsed.data.sessionID,
      contractFingerprint: parsed.data.contractFingerprint,
      poolFingerprint: parsed.data.poolFingerprint,
      subject: parsed.data.subject,
      config: parsed.data.config,
      stopReason: parsed.data.stopReason,
      estimate: parsed.data.estimate,
      revision: parsed.data.revision,
      completedAt: parsed.data.completedAt,
    }
    return state.status === "completed" && JSON.stringify(snapshot) === JSON.stringify(receipt) ? parsed.data : null
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    subject: { type: "run" | "candidate"; id: string }
    evaluatedAt: number
    recordedAt: number
    requireQualified: boolean
  }) {
    const receipt = await readReceipt(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt active audit receipt ${input.receiptID}`)
    if (!input.contract.audit)
      throw new Error(`Evaluation cites an audit receipt without a bound active audit protocol`)
    if (receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract)) {
      throw new Error(`Active audit receipt does not match the bound harness contract`)
    }
    if (receipt.sessionID !== input.contract.sessionID || receipt.runID !== input.contract.runID) {
      throw new Error(`Active audit receipt belongs to a different harness run`)
    }
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Active audit receipt belongs to a different evaluation subject`)
    }
    if (receipt.completedAt < input.contract.createdAt) {
      throw new Error(`Active audit receipt predates the bound harness contract`)
    }
    if (receipt.completedAt > input.evaluatedAt || receipt.sealedAt > input.recordedAt) {
      throw new Error(`Evaluation predates its active audit receipt`)
    }
    if (input.requireQualified && !receipt.qualified) {
      throw new Error(`A passing final evaluation requires a qualified non-abstaining active audit receipt`)
    }
    return receipt
  }
}
