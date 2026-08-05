import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessAdapter } from "./adapter"
import { HarnessAudit } from "./audit"
import { HarnessContract } from "./contract"

export namespace HarnessFailure {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  export const Subject = HarnessAudit.Subject
  export type Subject = HarnessAudit.Subject

  const Anchor = z
    .object({
      id: z.string().min(1).max(240),
      commitment: Hash,
      loss: z.number().min(0).max(1),
    })
    .strict()
  type Anchor = z.infer<typeof Anchor>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  export const Initialize = Access.extend({
    subject: Subject,
    auditReceiptID: Hash,
  }).strict()
  export type Initialize = z.infer<typeof Initialize>

  const Allocation = z
    .object({
      phase: z.enum(["initialization", "ucb1"]),
      pulls: z.number().int().nonnegative(),
      rewards: z.number().int().nonnegative(),
      score: z.number().finite(),
    })
    .strict()

  export const Selection = z
    .object({
      selectionID: Hash,
      round: z.number().int().positive(),
      topic: HarnessContract.FailureTopic,
      anchors: z.array(Anchor).min(1).max(8),
      allocation: Allocation,
      selectedAt: z.number().int().positive(),
    })
    .strict()
  export type Selection = z.infer<typeof Selection>

  export const Validation = z
    .object({
      kind: HarnessContract.FailureValidatorKind,
      status: z.enum(["passed", "failed", "inconclusive"]),
      score: z.number().finite().optional(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
      note: z.string().max(4_000).optional(),
    })
    .strict()
  export type Validation = z.infer<typeof Validation>

  const Failed = z
    .object({
      status: z.literal("failed"),
      mode: z.enum(["generator_error", "timeout", "invalid_output", "other"]),
      outputSHA256: Hash.optional(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  const Generated = z
    .object({
      status: z.literal("generated"),
      caseSHA256: Hash,
      outputSHA256: Hash,
      embedding: z.array(z.number().finite()).min(2).max(64),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  export const Generation = z.discriminatedUnion("status", [Failed, Generated])
  export type Generation = z.infer<typeof Generation>

  export const Outcome = z
    .object({
      loss: z.number().min(0).max(1),
      failure: z.boolean(),
      outputSHA256: Hash,
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()
  export type Outcome = z.infer<typeof Outcome>

  export const Observe = Access.extend({
    selectionID: Hash,
    generation: Generation,
    validations: z.array(Validation).max(HarnessContract.FailureValidatorKind.options.length),
    outcome: Outcome.optional(),
    evaluatedAt: z.number().int().positive(),
  })
    .strict()
    .superRefine((value, ctx) => {
      if (value.generation.status === "failed") {
        if (value.validations.length) {
          ctx.addIssue({ code: "custom", path: ["validations"], message: "A failed generation cannot be validated" })
        }
        if (value.outcome) {
          ctx.addIssue({
            code: "custom",
            path: ["outcome"],
            message: "A failed generation cannot have a target outcome",
          })
        }
        return
      }
      const kinds = value.validations.map((item) => item.kind)
      if (
        kinds.length !== HarnessContract.FailureValidatorKind.options.length ||
        new Set(kinds).size !== kinds.length ||
        HarnessContract.FailureValidatorKind.options.some((kind) => !kinds.includes(kind))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["validations"],
          message: "A generated case requires every frozen validator class exactly once",
        })
      }
      const passed = value.validations.every((item) => item.status === "passed")
      if (passed && !value.outcome) {
        ctx.addIssue({ code: "custom", path: ["outcome"], message: "A validated case requires a target outcome" })
      }
      if (!passed && value.outcome) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "An invalid or inconclusive generated case cannot enter target evaluation",
        })
      }
    })
  export type Observe = z.infer<typeof Observe>

  export const Attempt = z
    .object({
      attemptID: Hash,
      selection: Selection,
      generation: Generation,
      validations: z.array(Validation).max(HarnessContract.FailureValidatorKind.options.length),
      outcome: Outcome.optional(),
      admissible: z.boolean(),
      reward: z.union([z.literal(0), z.literal(1)]),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
  export type Attempt = z.infer<typeof Attempt>

  const Arm = z
    .object({
      pulls: z.number().int().nonnegative(),
      rewards: z.number().int().nonnegative(),
      rate: z.number().min(0).max(1),
    })
    .strict()

  export const Statistics = z
    .object({
      attempts: z.number().int().nonnegative(),
      generated: z.number().int().nonnegative(),
      admissible: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
      invalid: z.number().int().nonnegative(),
      samplesToFirstFailure: z.number().int().positive().optional(),
      failureRate: z.number().min(0).max(1),
      topicEntropy: z.number().min(0).max(1),
      embeddingLogDet: z.number().finite(),
      topics: z.record(z.string(), Arm),
    })
    .strict()
  export type Statistics = z.infer<typeof Statistics>

  export const Stop = z.enum(["budget_exhausted", "failure_target_reached"])
  export type Stop = z.infer<typeof Stop>

  export const State = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("topic-aware-failure-v1"),
      streamID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      subject: Subject,
      auditReceiptID: Hash,
      sourcePoolSHA256: Hash,
      anchors: z.array(Anchor).min(1).max(512),
      config: HarnessContract.FailureDiscovery,
      status: z.enum(["active", "completed"]),
      stopReason: Stop.optional(),
      pending: Selection.optional(),
      attempts: z.array(Attempt).max(512),
      statistics: Statistics,
      revision: z.number().int().nonnegative(),
      createdAt: z.number().int().positive(),
      updatedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.anchors.map((item) => item.id)).size !== value.anchors.length) {
        ctx.addIssue({ code: "custom", path: ["anchors"], message: "Failure anchors must be unique" })
      }
      if (new Set(value.attempts.map((item) => item.attemptID)).size !== value.attempts.length) {
        ctx.addIssue({ code: "custom", path: ["attempts"], message: "Failure attempts must be unique" })
      }
      if (value.pending && value.status !== "active") {
        ctx.addIssue({ code: "custom", path: ["pending"], message: "A completed failure stream cannot be pending" })
      }
      if ((value.status === "completed") !== Boolean(value.stopReason)) {
        ctx.addIssue({ code: "custom", path: ["stopReason"], message: "Failure stream terminal state is inconsistent" })
      }
    })
  export type State = z.infer<typeof State>

  const ReceiptBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("topic-aware-failure-receipt-v1"),
      receiptID: Hash,
      streamID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      subject: Subject,
      auditReceiptID: Hash,
      sourcePoolSHA256: Hash,
      config: HarnessContract.FailureDiscovery,
      attemptIDs: z.array(Hash).min(2).max(512),
      statistics: Statistics,
      stopReason: Stop,
      revision: z.number().int().positive(),
      completedAt: z.number().int().positive(),
      sealedAt: z.number().int().positive(),
    })
    .strict()

  export const Receipt = ReceiptBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.receiptID
    if (digest(stable) === value.receiptID) return
    ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Failure discovery receipt content hash is invalid" })
  })
  export type Receipt = z.infer<typeof Receipt>

  const root = path.join(Global.Path.data, "harness", "failures")
  const receiptRoot = path.join(Global.Path.data, "harness", "failure-receipts")
  const file = (sessionID: string, streamID: string) =>
    path.join(root, encodeURIComponent(sessionID), `${streamID}.json`)
  const receiptFile = (receiptID: string) => path.join(receiptRoot, `${receiptID}.json`)

  function logdet(input: number[][], dimensions: number, regularization: number) {
    if (!input.length) return 0
    const matrix = Array.from({ length: dimensions }, (_, row) =>
      Array.from({ length: dimensions }, (_, column) => (row === column ? 1 : 0)),
    )
    for (const embedding of input) {
      embedding.forEach((left, row) =>
        embedding.forEach((right, column) => {
          matrix[row]![column]! += (left * right) / regularization
        }),
      )
    }
    const lower = Array.from({ length: dimensions }, () => Array.from({ length: dimensions }, () => 0))
    Array.from({ length: dimensions }).forEach((_, row) =>
      Array.from({ length: row + 1 }).forEach((__, column) => {
        const prior = Array.from({ length: column }, (_, index) => index).reduce(
          (sum, index) => sum + lower[row]![index]! * lower[column]![index]!,
          0,
        )
        const value = matrix[row]![column]! - prior
        lower[row]![column] =
          row === column ? Math.sqrt(Math.max(value, Number.EPSILON)) : value / lower[column]![column]!
      }),
    )
    const determinant = 2 * lower.reduce((sum, row, index) => sum + Math.log(row[index]!), 0)
    return (input.length * Math.log(regularization) + determinant) / input.length
  }

  function statistics(config: HarnessContract.FailureDiscovery, attempts: Attempt[]) {
    const topics = Object.fromEntries(
      config.topics.map((topic) => {
        const selected = attempts.filter((attempt) => attempt.selection.topic.id === topic.id)
        const rewards = selected.reduce((sum, attempt) => sum + attempt.reward, 0)
        return [topic.id, { pulls: selected.length, rewards, rate: selected.length ? rewards / selected.length : 0 }]
      }),
    )
    const generated = attempts.filter((attempt) => attempt.generation.status === "generated")
    const admissible = attempts.filter((attempt) => attempt.admissible)
    const failures = admissible.filter((attempt) => attempt.reward === 1)
    const topicCounts = config.topics.map(
      (topic) => failures.filter((attempt) => attempt.selection.topic.id === topic.id).length,
    )
    const entropy = failures.length
      ? topicCounts.reduce((sum, count) => {
          if (!count) return sum
          const probability = count / failures.length
          return sum - probability * Math.log(probability)
        }, 0) / Math.log(config.topics.length)
      : 0
    const embeddings = failures.flatMap((attempt) =>
      attempt.generation.status === "generated" ? [attempt.generation.embedding] : [],
    )
    return Statistics.parse({
      attempts: attempts.length,
      generated: generated.length,
      admissible: admissible.length,
      failures: failures.length,
      invalid: attempts.length - admissible.length,
      samplesToFirstFailure: failures[0]?.selection.round,
      failureRate: admissible.length ? failures.length / admissible.length : 0,
      topicEntropy: entropy,
      embeddingLogDet: logdet(embeddings, config.embedding.dimensions, config.embedding.regularization),
      topics,
    })
  }

  function derive(
    config: HarnessContract.FailureDiscovery,
    prior: Attempt[],
    generation: Generation,
    validations: Validation[],
    outcome: Outcome | undefined,
  ): { valid: true; admissible: boolean; reward: 0 | 1 } | { valid: false; error: string } {
    if (generation.status === "failed") {
      if (validations.length) return { valid: false, error: "A failed generation cannot be validated" }
      if (outcome) return { valid: false, error: "A failed generation cannot have a target outcome" }
      return { valid: true, admissible: false, reward: 0 }
    }
    if (
      validations.length !== HarnessContract.FailureValidatorKind.options.length ||
      validations.some((item, index) => item.kind !== HarnessContract.FailureValidatorKind.options[index])
    ) {
      return { valid: false, error: "A generated case requires every frozen validator class exactly once" }
    }
    if (generation.embedding.length !== config.embedding.dimensions) {
      return { valid: false, error: "Failure discovery embedding does not match the frozen dimension" }
    }
    const norm = Math.sqrt(generation.embedding.reduce((sum, item) => sum + item * item, 0))
    if (Math.abs(norm - 1) > 1e-6) {
      return { valid: false, error: "Failure discovery embedding must be L2-normalized" }
    }
    const duplicate = prior.some(
      (attempt) => attempt.generation.status === "generated" && attempt.generation.caseSHA256 === generation.caseSHA256,
    )
    const novelty = validations.find((item) => item.kind === "novelty")!
    if (duplicate && novelty.status === "passed") {
      return { valid: false, error: "An exact duplicate generated case cannot pass novelty validation" }
    }
    const passed = validations.every((item) => item.status === "passed")
    if (passed && !outcome) return { valid: false, error: "A validated case requires a target outcome" }
    if (!passed && outcome) {
      return { valid: false, error: "An invalid or inconclusive generated case cannot enter target evaluation" }
    }
    if (outcome && outcome.failure !== outcome.loss >= config.failureThreshold) {
      return { valid: false, error: "Failure discovery label does not match the frozen loss threshold" }
    }
    const admissible = passed && outcome !== undefined
    return { valid: true, admissible, reward: admissible && outcome.failure ? 1 : 0 }
  }

  function stopped(config: HarnessContract.FailureDiscovery, attempts: Attempt[]) {
    const initialized = new Set(attempts.map((attempt) => attempt.selection.topic.id)).size === config.topics.length
    const failures = attempts.reduce((sum, attempt) => sum + attempt.reward, 0)
    if (initialized && config.targetFailures !== undefined && failures >= config.targetFailures) {
      return "failure_target_reached" as const
    }
    if (attempts.length >= config.budget) return "budget_exhausted" as const
    return undefined
  }

  function allocation(state: Pick<State, "streamID" | "config" | "attempts">) {
    const arms = statistics(state.config, state.attempts).topics
    const unpulled = state.config.topics.find((topic) => !arms[topic.id]!.pulls)
    if (unpulled) {
      return {
        topic: unpulled,
        allocation: {
          phase: "initialization" as const,
          pulls: arms[unpulled.id]!.pulls,
          rewards: arms[unpulled.id]!.rewards,
          score: Number.MAX_VALUE,
        },
      }
    }
    const total = Math.max(state.attempts.length, 1)
    const ranked = state.config.topics
      .map((topic) => {
        const arm = arms[topic.id]!
        return {
          topic,
          allocation: {
            phase: "ucb1" as const,
            pulls: arm.pulls,
            rewards: arm.rewards,
            score: arm.rate + state.config.exploration * Math.sqrt(Math.log(total) / arm.pulls),
          },
          tie: digest({ streamID: state.streamID, round: state.attempts.length + 1, topic: topic.commitment }),
        }
      })
      .toSorted((left, right) => right.allocation.score - left.allocation.score || compare(left.tie, right.tie))
    return ranked[0]!
  }

  function select(state: Pick<State, "streamID" | "config" | "attempts" | "anchors">, selectedAt: number) {
    const choice = allocation(state)
    const round = state.attempts.length + 1
    const anchors = state.anchors
      .map((anchor) => ({ anchor, tie: digest({ streamID: state.streamID, round, anchor: anchor.commitment }) }))
      .toSorted((left, right) => right.anchor.loss - left.anchor.loss || compare(left.tie, right.tie))
      .slice(0, state.config.anchorsPerAttempt)
      .map((item) => item.anchor)
    const stable = { round, topic: choice.topic, anchors, allocation: choice.allocation }
    return Selection.parse({
      ...stable,
      selectionID: digest({ streamID: state.streamID, ...stable }),
      selectedAt,
    })
  }

  function replay(state: State) {
    const origin = {
      runID: state.runID,
      sessionID: state.sessionID,
      contractFingerprint: state.contractFingerprint,
      subject: state.subject,
      auditReceiptID: state.auditReceiptID,
      sourcePoolSHA256: state.sourcePoolSHA256,
      config: state.config,
      anchors: state.anchors,
    }
    if (digest(origin) !== state.streamID) return false
    const prior: Attempt[] = []
    for (const attempt of state.attempts) {
      if (stopped(state.config, prior)) return false
      const expected = select({ ...state, attempts: prior }, attempt.selection.selectedAt)
      if (!same(expected, attempt.selection)) return false
      const result = derive(state.config, prior, attempt.generation, attempt.validations, attempt.outcome)
      if (!result.valid || result.admissible !== attempt.admissible || result.reward !== attempt.reward) return false
      const last = prior.at(-1)
      if (
        attempt.selection.selectedAt < (last?.recordedAt ?? state.createdAt) ||
        attempt.evaluatedAt < attempt.selection.selectedAt ||
        attempt.evaluatedAt > attempt.recordedAt + 300_000 ||
        attempt.recordedAt < attempt.selection.selectedAt
      ) {
        return false
      }
      const stable = {
        selection: attempt.selection,
        generation: attempt.generation,
        validations: attempt.validations,
        outcome: attempt.outcome,
        admissible: attempt.admissible,
        reward: attempt.reward,
        evaluatedAt: attempt.evaluatedAt,
        recordedAt: attempt.recordedAt,
      }
      if (digest(stable) !== attempt.attemptID) return false
      prior.push(attempt)
    }
    if (!same(statistics(state.config, state.attempts), state.statistics)) return false
    if (state.pending && !same(select(state, state.pending.selectedAt), state.pending)) return false
    if (state.revision !== state.attempts.length * 2 + (state.pending ? 1 : 0)) return false
    const updatedAt = state.pending?.selectedAt ?? state.attempts.at(-1)?.recordedAt ?? state.createdAt
    if (state.updatedAt !== updatedAt) return false
    const stop = stopped(state.config, state.attempts)
    return state.status === (stop ? "completed" : "active") && state.stopReason === stop
  }

  function parse(input: Record<string, unknown>) {
    const state = State.parse(input)
    if (!replay(state)) throw new Error(`Failure discovery state cannot be replayed from its immutable journal`)
    return state
  }

  async function read(sessionID: string, streamID: string) {
    return parse(await JsonStore.read(file(sessionID, Hash.parse(streamID))))
  }

  function match(state: State, contract: HarnessContract.Info) {
    if (state.sessionID !== contract.sessionID || state.runID !== contract.runID) {
      throw new Error(`Failure discovery stream belongs to a different harness run`)
    }
    if (
      state.contractFingerprint !== HarnessContract.fingerprint(contract) ||
      !same(state.config, contract.failureDiscovery)
    ) {
      throw new Error(`Failure discovery stream does not match the bound harness contract`)
    }
  }

  export async function initialize(input: Initialize) {
    const value = Initialize.parse(input)
    const contract = await HarnessAdapter.authorize(value.sessionID, value.evaluatorToken)
    const config = contract.failureDiscovery
    if (!config) throw new Error(`No topic-aware failure discovery protocol is bound to session ${value.sessionID}`)
    const now = Date.now()
    const receipt = await HarnessAudit.assert({
      contract,
      receiptID: value.auditReceiptID,
      subject: value.subject,
      evaluatedAt: now,
      recordedAt: now,
      requireQualified: false,
    })
    if (receipt.poolFingerprint !== config.sourcePoolSHA256) {
      throw new Error(`Failure discovery source pool does not match the frozen audit pool`)
    }
    if (!same(receipt.subject, value.subject)) {
      throw new Error(`Failure discovery subject artifact does not match its source audit receipt`)
    }
    const audit = await HarnessAudit.status(receipt.auditID, {
      sessionID: value.sessionID,
      evaluatorToken: value.evaluatorToken,
    })
    const anchors = audit.order.flatMap((id) => {
      const entry = audit.pool[id]
      return entry?.observation?.failure
        ? [{ id: entry.id, commitment: entry.commitment, loss: entry.observation.loss }]
        : []
    })
    if (anchors.length < config.anchorsPerAttempt) {
      throw new Error(`Failure discovery needs at least ${config.anchorsPerAttempt} authenticated failure anchors`)
    }
    const origin = {
      runID: contract.runID,
      sessionID: contract.sessionID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      subject: value.subject,
      auditReceiptID: receipt.receiptID,
      sourcePoolSHA256: receipt.poolFingerprint,
      config,
      anchors,
    }
    const state = State.parse({
      schemaVersion: 1,
      protocolVersion: "topic-aware-failure-v1",
      streamID: digest(origin),
      ...origin,
      status: "active",
      attempts: [],
      statistics: statistics(config, []),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    await JsonStore.update(file(state.sessionID, state.streamID), (data) => {
      if (!Object.keys(data).length) return state
      const current = parse(data)
      if (current.streamID === state.streamID) return current
      throw new Error(`Failure discovery stream is immutable once initialized`)
    })
    return read(state.sessionID, state.streamID)
  }

  export async function status(streamID: string, input: Access) {
    const access = Access.parse(input)
    const contract = await HarnessAdapter.authorize(access.sessionID, access.evaluatorToken)
    const state = await read(access.sessionID, streamID)
    match(state, contract)
    return state
  }

  export async function next(streamID: string, input: Access) {
    const access = Access.parse(input)
    const contract = await HarnessAdapter.authorize(access.sessionID, access.evaluatorToken)
    const result = { selection: undefined as Selection | undefined }
    await JsonStore.update(file(access.sessionID, Hash.parse(streamID)), (data) => {
      const state = parse(data)
      match(state, contract)
      if (state.status !== "active") throw new Error(`Failure discovery stream is already complete`)
      if (state.pending) {
        result.selection = state.pending
        return state
      }
      const now = Math.max(Date.now(), state.updatedAt)
      const selection = select(state, now)
      result.selection = selection
      return State.parse({ ...state, pending: selection, revision: state.revision + 1, updatedAt: now })
    })
    if (!result.selection) throw new Error(`Failure discovery selection was not durable after recording`)
    return result.selection
  }

  export async function observe(streamID: string, input: Observe) {
    const value = Observe.parse(input)
    const validations = value.validations.toSorted(
      (left, right) =>
        HarnessContract.FailureValidatorKind.options.indexOf(left.kind) -
        HarnessContract.FailureValidatorKind.options.indexOf(right.kind),
    )
    const contract = await HarnessAdapter.authorize(value.sessionID, value.evaluatorToken)
    const submittedAt = Date.now()
    if (value.evaluatedAt > submittedAt + 300_000) {
      throw new Error(`Failure discovery outcome is unreasonably future-dated`)
    }
    await JsonStore.update(file(value.sessionID, Hash.parse(streamID)), (data) => {
      const state = parse(data)
      match(state, contract)
      const previous = state.attempts.find((attempt) => attempt.selection.selectionID === value.selectionID)
      if (previous) {
        const submitted = {
          generation: value.generation,
          validations,
          outcome: value.outcome,
          evaluatedAt: value.evaluatedAt,
        }
        const recorded = {
          generation: previous.generation,
          validations: previous.validations,
          outcome: previous.outcome,
          evaluatedAt: previous.evaluatedAt,
        }
        if (same(submitted, recorded)) return state
        throw new Error(`Failure discovery attempt is immutable once recorded`)
      }
      if (state.status !== "active" || !state.pending) throw new Error(`Failure discovery has no pending selection`)
      if (state.pending.selectionID !== value.selectionID) {
        throw new Error(`Failure discovery attempt does not match the server-selected topic and anchors`)
      }
      if (value.evaluatedAt < state.pending.selectedAt) {
        throw new Error(`Failure discovery outcome predates its selection`)
      }
      const result = derive(state.config, state.attempts, value.generation, validations, value.outcome)
      if (!result.valid) throw new Error(result.error)
      const now = Math.max(submittedAt, state.updatedAt)
      const stable = {
        selection: state.pending,
        generation: value.generation,
        validations,
        outcome: value.outcome,
        admissible: result.admissible,
        reward: result.reward,
        evaluatedAt: value.evaluatedAt,
        recordedAt: now,
      }
      const attempt = Attempt.parse({ ...stable, attemptID: digest(stable) })
      const attempts = [...state.attempts, attempt]
      const stats = statistics(state.config, attempts)
      const stop = stopped(state.config, attempts)
      return State.parse({
        ...state,
        pending: undefined,
        attempts,
        statistics: stats,
        status: stop ? "completed" : "active",
        stopReason: stop,
        revision: state.revision + 1,
        updatedAt: now,
      })
    })
    return read(value.sessionID, streamID)
  }

  export async function seal(streamID: string, input: Access) {
    const access = Access.parse(input)
    const contract = await HarnessAdapter.authorize(access.sessionID, access.evaluatorToken)
    const state = await read(access.sessionID, streamID)
    match(state, contract)
    if (state.status !== "completed" || !state.stopReason) {
      throw new Error(`Failure discovery must reach a terminal state before sealing`)
    }
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "topic-aware-failure-receipt-v1" as const,
      streamID: state.streamID,
      runID: state.runID,
      sessionID: state.sessionID,
      contractFingerprint: state.contractFingerprint,
      subject: state.subject,
      auditReceiptID: state.auditReceiptID,
      sourcePoolSHA256: state.sourcePoolSHA256,
      config: state.config,
      attemptIDs: state.attempts.map((attempt) => attempt.attemptID),
      statistics: state.statistics,
      stopReason: state.stopReason,
      revision: state.revision,
      completedAt: state.updatedAt,
      sealedAt: state.updatedAt,
    }
    const receipt = Receipt.parse({ ...stable, receiptID: digest(stable) })
    await JsonStore.update(receiptFile(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Failure discovery receipt is immutable once recorded`)
    })
    const saved = await readReceipt(receipt.receiptID)
    if (!saved) throw new Error(`Failure discovery receipt was not durable after recording`)
    return saved
  }

  export async function readReceipt(receiptID: string) {
    const id = Hash.parse(receiptID)
    const parsed = Receipt.safeParse(await JsonStore.read(receiptFile(id)))
    if (!parsed.success || parsed.data.receiptID !== id) return null
    const state = await JsonStore.read(file(parsed.data.sessionID, parsed.data.streamID))
    const current = State.safeParse(state)
    if (!current.success || !replay(current.data) || current.data.status !== "completed") return null
    const source = await HarnessAudit.readReceipt(current.data.auditReceiptID)
    if (
      !source ||
      source.contractFingerprint !== current.data.contractFingerprint ||
      source.poolFingerprint !== current.data.sourcePoolSHA256 ||
      !same(source.subject, current.data.subject)
    ) {
      return null
    }
    const snapshot = {
      streamID: current.data.streamID,
      runID: current.data.runID,
      sessionID: current.data.sessionID,
      contractFingerprint: current.data.contractFingerprint,
      subject: current.data.subject,
      auditReceiptID: current.data.auditReceiptID,
      sourcePoolSHA256: current.data.sourcePoolSHA256,
      config: current.data.config,
      attemptIDs: current.data.attempts.map((attempt) => attempt.attemptID),
      statistics: current.data.statistics,
      stopReason: current.data.stopReason,
      revision: current.data.revision,
      completedAt: current.data.updatedAt,
      sealedAt: current.data.updatedAt,
    }
    const receipt = { ...parsed.data }
    delete (receipt as Partial<Receipt>).schemaVersion
    delete (receipt as Partial<Receipt>).protocolVersion
    delete (receipt as Partial<Receipt>).receiptID
    return same(snapshot, receipt) ? parsed.data : null
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    subject: { type: "run" | "candidate"; id: string }
    evaluatedAt: number
    recordedAt: number
  }) {
    const receipt = await readReceipt(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt failure discovery receipt ${input.receiptID}`)
    if (!input.contract.failureDiscovery) {
      throw new Error(`Evaluation cites a failure discovery receipt without a bound protocol`)
    }
    if (
      receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract) ||
      receipt.sessionID !== input.contract.sessionID ||
      receipt.runID !== input.contract.runID
    ) {
      throw new Error(`Failure discovery receipt belongs to a different harness run`)
    }
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Failure discovery receipt belongs to a different evaluation subject`)
    }
    if (receipt.completedAt < input.contract.createdAt) {
      throw new Error(`Failure discovery receipt predates the bound harness contract`)
    }
    if (receipt.completedAt > input.evaluatedAt || receipt.sealedAt > input.recordedAt) {
      throw new Error(`Evaluation predates its failure discovery receipt`)
    }
    return receipt
  }
}
