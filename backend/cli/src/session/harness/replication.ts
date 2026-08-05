import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessReplication {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  export const Subject = z
    .object({
      type: z.enum(["run", "candidate"]),
      id: z.string().min(1).max(240),
    })
    .strict()
  export type Subject = z.infer<typeof Subject>

  export const Observation = z
    .object({
      stratumID: z.string().min(1).max(120),
      clusterID: z.string().min(1).max(120),
      stratumSHA256: Hash,
      clusterSHA256: Hash,
      status: z.enum(["passed", "failed", "inconclusive"]),
      score: z.number().finite().optional(),
      outputSHA256: Hash,
      environmentSHA256: Hash,
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Observation = z.infer<typeof Observation>

  export const Submit = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
      subject: Subject,
      observations: z.array(Observation).min(3).max(512),
    })
    .strict()
  export type Submit = z.input<typeof Submit>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  const Statistics = z
    .object({
      units: z.number().int().positive(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      inconclusive: z.number().int().nonnegative(),
      estimator: HarnessContract.ReplicationEstimator,
      estimate: z.number().finite().optional(),
      confidence: z.literal(0.95),
      interval: z.tuple([z.number().finite(), z.number().finite()]).optional(),
      intervalWidth: z.number().finite().nonnegative().optional(),
      conservativeBound: z.number().finite().optional(),
      method: z.enum(["stratified-bootstrap-percentile-v1", "wilson-score-v1"]),
      resamples: z.number().int().positive().optional(),
    })
    .strict()

  const ReceiptBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("replicated-evaluation-receipt-v1"),
      receiptID: Hash,
      protocolSHA256: Hash,
      contractSHA256: Hash,
      sourceSessionID: z.string().min(1).max(240),
      subject: Subject,
      metric: z.string().min(1).max(200),
      protocol: HarnessContract.Replication,
      observations: z.array(Observation).min(3).max(512),
      statistics: Statistics,
      status: z.enum(["passed", "failed", "inconclusive"]),
      failures: z.array(z.string().min(1).max(500)).max(1_024),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(16_384),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()

  export const Receipt = ReceiptBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.receiptID
    if (digest(stable) === value.receiptID) return
    ctx.addIssue({
      code: "custom",
      path: ["receiptID"],
      message: "Replicated evaluation receipt content hash is invalid",
    })
  })
  export type Receipt = z.infer<typeof Receipt>

  const Claim = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      protocolSHA256: Hash,
      contractSHA256: Hash,
      sourceSessionID: z.string().min(1).max(240),
      subject: Subject,
    })
    .strict()

  const root = path.join(Global.Path.data, "harness", "replications")
  const file = (receiptID: string) => path.join(root, `${receiptID}.json`)
  const claimfile = (contract: HarnessContract.Info, subject: Subject) =>
    path.join(root, "subjects", digest(contract.sessionID), `${digest(subject)}.json`)
  const key = (input: Pick<Observation, "stratumID" | "clusterID">) => `${input.stratumID}\0${input.clusterID}`
  const sorted = (input: Observation[]) =>
    input.toSorted(
      (left, right) => left.stratumID.localeCompare(right.stratumID) || left.clusterID.localeCompare(right.clusterID),
    )

  function average(input: Array<{ value: number; weight: number }>) {
    const scale = Math.max(...input.map((item) => Math.abs(item.value)))
    if (scale === 0) return 0
    const total = input.reduce((sum, item) => sum + item.weight, 0)
    const state = { sum: 0, correction: 0 }
    for (const item of input) {
      const value = (item.value / scale) * item.weight
      const next = state.sum + value
      state.correction += Math.abs(state.sum) >= Math.abs(value) ? state.sum - next + value : value - next + state.sum
      state.sum = next
    }
    return ((state.sum + state.correction) / total) * scale
  }

  function estimate(kind: Exclude<HarnessContract.ReplicationEstimator, "pass_rate">, input: number[]) {
    const values = input.toSorted((left, right) => left - right)
    if (kind === "mean") return average(values.map((value) => ({ value, weight: 1 })))
    if (kind === "median") {
      const middle = Math.floor(values.length / 2)
      return values.length % 2
        ? values[middle]!
        : average([
            { value: values[middle - 1]!, weight: 1 },
            { value: values[middle]!, weight: 1 },
          ])
    }
    return average(
      values.flatMap((value, index) => {
        const lower = Math.max(index / values.length, 0.25)
        const upper = Math.min((index + 1) / values.length, 0.75)
        const weight = Math.max(0, upper - lower)
        return weight === 0 ? [] : [{ value, weight }]
      }),
    )
  }

  function quantile(input: number[], probability: number) {
    const values = input.toSorted((left, right) => left - right)
    const position = (values.length - 1) * probability
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    if (lower === upper) return values[lower]!
    const weight = position - lower
    return average([
      { value: values[lower]!, weight: 1 - weight },
      { value: values[upper]!, weight },
    ])
  }

  function bootstrap(protocol: HarnessContract.Replication, observations: Observation[]) {
    if (protocol.interval.method !== "stratified-bootstrap-percentile-v1") {
      throw new Error(`Numeric replicated evaluation requires a stratified bootstrap interval`)
    }
    if (protocol.estimator === "pass_rate") throw new Error(`Pass-rate evaluation cannot use numeric bootstrap`)
    const estimator = protocol.estimator
    const scores = new Map(observations.map((item) => [key(item), item.score!]))
    const state = { value: protocol.interval.seed >>> 0 }
    const random = () => {
      state.value = (state.value + 0x6d2b79f5) >>> 0
      const first = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
      const second = first + Math.imul(first ^ (first >>> 7), 61 | first)
      return ((second ^ (second >>> 14)) >>> 0) / 4294967296
    }
    const draws = Array.from({ length: protocol.interval.resamples }, () => {
      const strata = Array.from(
        { length: protocol.sampling.strata.length },
        () => protocol.sampling.strata[Math.floor(random() * protocol.sampling.strata.length)]!,
      )
      return estimate(
        estimator,
        strata.flatMap((stratum) =>
          Array.from({ length: protocol.sampling.clusters.length }, () => {
            const cluster = protocol.sampling.clusters[Math.floor(random() * protocol.sampling.clusters.length)]!
            return scores.get(`${stratum.id}\0${cluster.id}`)!
          }),
        ),
      )
    })
    const alpha = 1 - protocol.interval.confidence
    return [quantile(draws, alpha / 2), quantile(draws, 1 - alpha / 2)] as [number, number]
  }

  function wilson(passed: number, total: number) {
    const probability = passed / total
    const z = 1.959963984540054
    const scale = 1 + (z * z) / total
    const center = (probability + (z * z) / (2 * total)) / scale
    const radius = (z * Math.sqrt((probability * (1 - probability)) / total + (z * z) / (4 * total * total))) / scale
    return [Math.max(0, center - radius), Math.min(1, center + radius)] as [number, number]
  }

  function evidence(observations: Observation[]) {
    return [...new Set(observations.flatMap((item) => item.evidence))].toSorted()
  }

  function inspect(protocol: HarnessContract.Replication, input: Observation[]) {
    const observations = sorted(input.map((item) => Observation.parse(item)))
    if (new Set(observations.map(key)).size !== observations.length) {
      throw new Error(`Replicated evaluation units must be unique`)
    }
    const expected = protocol.sampling.strata
      .flatMap((stratum) => protocol.sampling.clusters.map((cluster) => `${stratum.id}\0${cluster.id}`))
      .toSorted()
    if (JSON.stringify(observations.map(key)) !== JSON.stringify(expected)) {
      throw new Error(`Replicated evaluation must contain the complete frozen stratum-cluster grid`)
    }
    for (const observation of observations) {
      const stratum = protocol.sampling.strata.find((item) => item.id === observation.stratumID)!
      const cluster = protocol.sampling.clusters.find((item) => item.id === observation.clusterID)!
      if (
        observation.stratumSHA256 !== stratum.commitmentSHA256 ||
        observation.clusterSHA256 !== cluster.commitmentSHA256
      ) {
        throw new Error(`Replicated evaluation unit ${key(observation)} changed a frozen axis commitment`)
      }
      if (observation.environmentSHA256 !== protocol.environmentSHA256) {
        throw new Error(`Replicated evaluation unit ${key(observation)} changed the frozen environment`)
      }
      if (protocol.estimator === "pass_rate" && observation.score !== undefined) {
        throw new Error(`Pass-rate observations cannot submit agent-selected numeric scores`)
      }
      if (protocol.estimator !== "pass_rate" && observation.status === "passed" && observation.score === undefined) {
        throw new Error(`Passing numeric replicate ${key(observation)} must report a score`)
      }
      if (protocol.estimator !== "pass_rate" && observation.status !== "passed" && observation.score !== undefined) {
        throw new Error(`Non-passing numeric replicate ${key(observation)} cannot contribute a score`)
      }
    }
    const passed = observations.filter((item) => item.status === "passed").length
    const failed = observations.filter((item) => item.status === "failed").length
    const inconclusive = observations.length - passed - failed
    const base = {
      units: observations.length,
      passed,
      failed,
      inconclusive,
      estimator: protocol.estimator,
      confidence: 0.95 as const,
      method: protocol.interval.method,
      ...(protocol.interval.method === "stratified-bootstrap-percentile-v1"
        ? { resamples: protocol.interval.resamples }
        : {}),
    }
    if (protocol.estimator !== "pass_rate" && (failed || inconclusive)) {
      const status = failed ? ("failed" as const) : ("inconclusive" as const)
      const failures = observations.flatMap((item) =>
        item.status === "passed" ? [] : [`unit:${item.stratumID}/${item.clusterID}:${item.status}`],
      )
      return { observations, statistics: Statistics.parse(base), status, failures }
    }
    const values = observations.flatMap((item) => (item.score === undefined ? [] : [item.score]))
    const point =
      protocol.estimator === "pass_rate" ? passed / observations.length : estimate(protocol.estimator, values)
    const interval =
      protocol.estimator === "pass_rate" ? wilson(passed, observations.length) : bootstrap(protocol, observations)
    const width = interval[1] - interval[0]
    const bound = protocol.decision.direction === "minimize" ? interval[1] : interval[0]
    const target =
      protocol.decision.direction === "minimize" ? bound <= protocol.decision.target : bound >= protocol.decision.target
    const precise = protocol.decision.maxIntervalWidth === undefined || width <= protocol.decision.maxIntervalWidth
    const uncertain = inconclusive > 0
    const failures = [
      ...(uncertain ? [`${inconclusive} replicated units were inconclusive`] : []),
      ...(!target
        ? [
            `conservative bound ${bound} does not satisfy ${protocol.decision.direction} target ${protocol.decision.target}`,
          ]
        : []),
      ...(!precise ? [`interval width ${width} exceeds ${protocol.decision.maxIntervalWidth}`] : []),
    ]
    const status = uncertain ? ("inconclusive" as const) : target && precise ? ("passed" as const) : ("failed" as const)
    return {
      observations,
      statistics: Statistics.parse({
        ...base,
        estimate: point,
        interval,
        intervalWidth: width,
        conservativeBound: bound,
      }),
      status,
      failures,
    }
  }

  async function born(contract: HarnessContract.Info, subject: Subject) {
    if (subject.type === "run") {
      if (subject.id !== contract.runID)
        throw new Error(`Replicated evaluation run subject does not match its contract`)
      return contract.createdAt
    }
    const state = await import("./search")
      .then((module) => module.HarnessSearch.read(contract.sessionID))
      .catch(() => null)
    const candidate = state?.runID === contract.runID ? state.candidates[subject.id] : undefined
    if (!candidate) throw new Error(`Replicated evaluation candidate does not exist in the bound search`)
    return candidate.createdAt
  }

  function sameSubject(subject: Subject, input?: { type: "run" | "candidate"; id: string }) {
    if (subject.type === "candidate") return input?.type === "candidate" && input.id === subject.id
    return input === undefined || (input.type === "run" && input.id === subject.id)
  }

  async function claim(contract: HarnessContract.Info, subject: Subject) {
    const data = await JsonStore.read(claimfile(contract, subject))
    if (!Object.keys(data).length) return null
    return Claim.parse(data)
  }

  export function prompt(contract: HarnessContract.Info) {
    const protocol = contract.replication
    if (!protocol) return ""
    const units = protocol.sampling.strata.length * protocol.sampling.clusters.length
    return [
      "<replicated-evaluation-policy>",
      "The evaluator froze this uncertainty protocol before execution. Treat it as evaluation policy, not evidence that a result passes.",
      `Evaluate the complete ${protocol.sampling.strata.length} ${protocol.sampling.stratumKind} × ${protocol.sampling.clusters.length} ${protocol.sampling.clusterKind} clusters (${units} units) using its exact axis commitments; no subset, duplicate, substitution, or post-hoc unit is admissible.`,
      `Estimator: ${protocol.estimator}; interval: ${protocol.interval.method} at 95% confidence.`,
      `All units must use the frozen environment commitment ${protocol.environmentSHA256}.`,
      `Promotion rule: ${protocol.decision.rule}; direction=${protocol.decision.direction}; target=${protocol.decision.target}${protocol.decision.maxIntervalWidth === undefined ? "" : `; max_interval_width=${protocol.decision.maxIntervalWidth}`}.`,
      "A final score must equal the backend-derived aggregate. A passing result must satisfy the conservative confidence bound, not the best replicate or point estimate.",
      "Do not split repeated measurements into fake independent clusters, tune on frozen units, omit failures, or claim replication compliance yourself; produce immutable outputs and evidence for the evaluator.",
      "</replicated-evaluation-policy>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    return contract ? prompt(contract) : ""
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const protocol = contract.replication
    if (!protocol) throw new Error(`Harness contract does not require replicated evaluation`)
    if (value.sessionID !== contract.sessionID)
      throw new Error(`Replicated evaluation session does not match its contract`)
    const createdAt = await born(contract, value.subject)
    const existing = await import("./evaluation").then((module) => module.HarnessEvaluation.list(contract.sessionID))
    if (existing.some((item) => moduleFinal(item) && sameSubject(value.subject, item.subject))) {
      throw new Error(`Replicated evaluation receipt must be recorded before the subject's final evaluation`)
    }
    const now = Date.now()
    for (const observation of value.observations) {
      if (observation.evaluatedAt < createdAt || observation.evaluatedAt > now) {
        throw new Error(`Replicated observation timestamp is outside the bound subject interval`)
      }
    }
    const audit = inspect(protocol, value.observations)
    const metric = contract.benchmark.metric
    if (!metric) throw new Error(`Replicated evaluation contract has no bound metric`)
    const claimed = await claim(contract, value.subject)
    if (claimed) {
      const current = await read(claimed.receiptID)
      if (!current) throw new Error(`The subject's frozen replicated evaluation receipt is corrupt`)
      if (
        current.protocolSHA256 !== digest(protocol) ||
        current.contractSHA256 !== HarnessContract.fingerprint(contract) ||
        current.sourceSessionID !== contract.sessionID ||
        !sameSubject(value.subject, current.subject)
      ) {
        throw new Error(`The subject's frozen replicated evaluation claim does not match its bound contract`)
      }
      if (JSON.stringify(current.observations) === JSON.stringify(audit.observations)) return current
      throw new Error(`The subject already has a frozen replicated evaluation receipt; selective retries are forbidden`)
    }
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "replicated-evaluation-receipt-v1" as const,
      protocolSHA256: digest(protocol),
      contractSHA256: HarnessContract.fingerprint(contract),
      sourceSessionID: contract.sessionID,
      subject: value.subject,
      metric,
      protocol,
      observations: audit.observations,
      statistics: audit.statistics,
      status: audit.status,
      failures: audit.failures,
      evidence: evidence(audit.observations),
      evaluatedAt: Math.max(...audit.observations.map((item) => item.evaluatedAt)),
      recordedAt: now,
    }
    const receipt = Receipt.parse({ ...stable, receiptID: digest(stable) })
    await JsonStore.update(file(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Replicated evaluation receipt is immutable once recorded`)
    })
    const saved = await read(receipt.receiptID)
    if (!saved) throw new Error(`Replicated evaluation receipt was not durable after recording`)
    const statement = Claim.parse({
      schemaVersion: 1,
      receiptID: saved.receiptID,
      protocolSHA256: saved.protocolSHA256,
      contractSHA256: saved.contractSHA256,
      sourceSessionID: saved.sourceSessionID,
      subject: saved.subject,
    })
    await JsonStore.update(claimfile(contract, value.subject), async (data) => {
      if (!Object.keys(data).length) return statement
      const current = Claim.parse(data)
      if (current.receiptID === statement.receiptID) return current
      const winner = await read(current.receiptID)
      if (winner && JSON.stringify(winner.observations) === JSON.stringify(audit.observations)) return current
      throw new Error(`The subject already has a frozen replicated evaluation receipt; selective retries are forbidden`)
    })
    const active = await claim(contract, value.subject)
    if (active?.receiptID !== saved.receiptID) {
      const winner = active ? await read(active.receiptID) : null
      if (winner && JSON.stringify(winner.observations) === JSON.stringify(audit.observations)) return winner
      throw new Error(`Replicated evaluation receipt was not durably frozen for its subject`)
    }
    return saved
  }

  const moduleFinal = (input: { fidelity?: { final: boolean } }) => input.fidelity?.final !== false

  export async function read(receiptID: string) {
    const id = Hash.parse(receiptID)
    const data = await JsonStore.read(file(id))
    const parsed = Receipt.safeParse(data)
    return parsed.success && parsed.data.receiptID === id ? parsed.data : null
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    subject: Subject
    score?: number
    evaluatedAt: number
    recordedAt: number
    requirePassed: boolean
  }) {
    const receipt = await read(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt replicated evaluation receipt ${input.receiptID}`)
    const protocol = input.contract.replication
    if (!protocol) throw new Error(`Evaluation cites a replication receipt without a bound replication protocol`)
    if (receipt.protocolSHA256 !== digest(protocol) || JSON.stringify(receipt.protocol) !== JSON.stringify(protocol)) {
      throw new Error(`Replicated evaluation receipt does not match the bound protocol`)
    }
    if (receipt.sourceSessionID !== input.contract.sessionID) {
      throw new Error(`Replicated evaluation receipt belongs to a different harness session`)
    }
    if (receipt.contractSHA256 !== HarnessContract.fingerprint(input.contract)) {
      throw new Error(`Replicated evaluation receipt does not match the bound contract`)
    }
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Replicated evaluation receipt belongs to a different evaluation subject`)
    }
    if (receipt.metric !== input.contract.benchmark.metric) {
      throw new Error(`Replicated evaluation receipt changed the bound metric`)
    }
    const active = await claim(input.contract, input.subject)
    if (active?.receiptID !== receipt.receiptID) {
      throw new Error(`Evaluation cites a non-canonical receipt instead of the subject's frozen receipt`)
    }
    const createdAt = await born(input.contract, input.subject)
    const audit = inspect(protocol, receipt.observations)
    if (
      receipt.status !== audit.status ||
      JSON.stringify(receipt.failures) !== JSON.stringify(audit.failures) ||
      JSON.stringify(receipt.statistics) !== JSON.stringify(audit.statistics) ||
      JSON.stringify(receipt.evidence) !== JSON.stringify(evidence(audit.observations)) ||
      receipt.evaluatedAt !== Math.max(...audit.observations.map((item) => item.evaluatedAt))
    ) {
      throw new Error(`Replicated evaluation receipt does not match backend-derived uncertainty state`)
    }
    if (
      audit.observations.some(
        (observation) => observation.evaluatedAt < createdAt || observation.evaluatedAt > receipt.recordedAt,
      )
    ) {
      throw new Error(`Replicated evaluation receipt contains an observation outside the bound subject interval`)
    }
    if (receipt.evaluatedAt > input.evaluatedAt || receipt.recordedAt > input.recordedAt) {
      throw new Error(`Evaluation predates its replicated evaluation receipt`)
    }
    if (input.score !== undefined && receipt.statistics.estimate !== input.score) {
      throw new Error(`Final evaluation score does not match the backend-derived replicated estimate`)
    }
    if (input.requirePassed && input.score === undefined) {
      throw new Error(`A passing replicated evaluation must report the backend-derived aggregate score`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A passing final evaluation requires a passing conservative replication receipt`)
    }
    return receipt
  }
}
