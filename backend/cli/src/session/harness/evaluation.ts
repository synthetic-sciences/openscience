import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessDomain } from "./domain"
import { HarnessJudge } from "./judge"
import { HarnessIntegrity } from "./integrity"
import { HarnessEvolution } from "./evolution"
import { HarnessIntervention } from "./intervention"
import { HarnessSimulation } from "./simulation"
import { HarnessSemantic } from "./semantic"
import { HarnessReplication } from "./replication"

export namespace HarnessEvaluation {
  export const Status = z.enum(["passed", "failed", "inconclusive"])
  export type Status = z.infer<typeof Status>

  export const Check = z
    .object({
      id: z.string().min(1).max(200),
      status: Status,
      blocking: z.boolean(),
      score: z.number().finite().optional(),
      evidence: z.array(z.string().min(1).max(1_000)).max(32).default([]),
      note: z.string().max(4_000).optional(),
    })
    .strict()
  export type Check = z.infer<typeof Check>

  export const Usage = z
    .object({
      wallTimeMs: z.number().nonnegative().optional(),
      costUSD: z.number().nonnegative().optional(),
    })
    .strict()
    .refine(
      (value) => value.wallTimeMs !== undefined || value.costUSD !== undefined,
      "Evaluation usage cannot be empty",
    )
  export type Usage = z.infer<typeof Usage>

  export const Info = z
    .object({
      schemaVersion: z.literal(1),
      runID: z.string().min(1),
      sessionID: z.string().min(1),
      subject: z
        .object({
          type: z.enum(["run", "candidate"]),
          id: z.string().min(1),
        })
        .strict()
        .optional(),
      fidelity: z
        .object({
          stage: z.string().min(1).max(100),
          final: z.boolean(),
        })
        .strict()
        .optional(),
      simulationReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      integrityReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      evolutionReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      interventionReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      evaluatorAuditReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      semanticReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      replicationReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      auditReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      failureDiscoveryReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      synthesisReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      autonomyReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      proofReceiptID: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      evaluator: z
        .object({
          name: z.string().min(1).max(200),
          version: z.string().min(1).max(200),
          source: z.enum(["benchmark", "gate", "human", "external"]),
        })
        .strict(),
      status: Status,
      score: z.number().finite().optional(),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "An evaluation may contain at most 128 metrics")
        .default({}),
      checks: z.array(Check).max(128),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      usage: Usage.optional(),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive().optional(),
      notes: z.string().max(8_000).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.status !== "passed") return
      const failed = value.checks.find((check) => check.blocking && check.status !== "passed")
      if (!failed) return
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: `A passed evaluation cannot contain a non-passing blocking check: ${failed.id}`,
      })
    })
  export type Info = z.infer<typeof Info>

  const State = z
    .object({
      schemaVersion: z.literal(1),
      items: z.record(z.string(), Info),
      order: z.array(z.string()),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.order).size !== value.order.length) {
        ctx.addIssue({ code: "custom", path: ["order"], message: "Evaluation journal order must be unique" })
      }
      for (const key of value.order) {
        if (value.items[key]) continue
        ctx.addIssue({ code: "custom", path: ["order"], message: `Evaluation journal is missing ${key}` })
      }
    })
  type State = z.infer<typeof State>

  const root = path.join(Global.Path.data, "harness", "evaluations")
  const file = (sessionID: string) => path.join(root, `${encodeURIComponent(sessionID)}.json`)
  const key = (input: Pick<Info, "subject" | "fidelity">) => {
    const subject = input.subject ? `${input.subject.type}:${input.subject.id}` : "run"
    return input.fidelity ? `${subject}@${input.fidelity.stage}` : subject
  }
  const empty = (): State => ({ schemaVersion: 1, items: {}, order: [] })

  function state(input: Record<string, unknown>) {
    const legacy = Info.safeParse(input)
    if (!legacy.success) return State.parse(Object.keys(input).length ? input : empty())
    const id = key(legacy.data)
    return State.parse({ schemaVersion: 1, items: { [id]: legacy.data }, order: [id] })
  }

  export function fingerprint(input: Info) {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(Info.parse(input))).digest("hex")
  }

  export function passed(input: Info) {
    const evaluation = Info.parse(input)
    return (
      evaluation.status === "passed" && evaluation.checks.every((check) => !check.blocking || check.status === "passed")
    )
  }

  export const final = (input: Info) => Info.parse(input).fidelity?.final !== false
  export const verified = (input: Info) => passed(input) && final(input)

  export async function record(input: Info) {
    const submitted = Info.parse(input)
    const evaluation = Info.parse({ ...submitted, recordedAt: Date.now() })
    const contract = await HarnessContract.read(evaluation.sessionID)
    if (!contract) throw new Error(`No harness contract is bound to session ${evaluation.sessionID}`)
    if (contract.runID !== evaluation.runID) {
      throw new Error(`Evaluation run ${evaluation.runID} does not match contract run ${contract.runID}`)
    }
    if (contract.benchmark.evaluator !== evaluation.evaluator.name) {
      throw new Error(
        `Evaluation source ${evaluation.evaluator.name} does not match contract evaluator ${contract.benchmark.evaluator}`,
      )
    }
    if (
      contract.benchmark.evaluatorVersion !== undefined &&
      contract.benchmark.evaluatorVersion !== evaluation.evaluator.version
    ) {
      throw new Error(
        `Evaluation version ${evaluation.evaluator.version} does not match contract evaluator version ${contract.benchmark.evaluatorVersion}`,
      )
    }
    if (
      contract.benchmark.evaluatorSource !== undefined &&
      contract.benchmark.evaluatorSource !== evaluation.evaluator.source
    ) {
      throw new Error(
        `Evaluation source ${evaluation.evaluator.source} does not match contract source ${contract.benchmark.evaluatorSource}`,
      )
    }
    const plan = contract.benchmark.fidelities
    if (!plan && evaluation.fidelity) throw new Error(`Evaluation fidelity is not declared by the bound contract`)
    if (plan && !evaluation.fidelity) throw new Error(`Evaluation must name a fidelity stage`)
    const stage = evaluation.fidelity ? plan?.find((item) => item.id === evaluation.fidelity?.stage) : undefined
    if (evaluation.fidelity && !stage) throw new Error(`Evaluation fidelity stage is not in the bound contract`)
    if (stage && stage.final !== evaluation.fidelity?.final) {
      throw new Error(`Evaluation fidelity finality does not match the bound contract`)
    }
    if (evaluation.simulationReceiptID && !contract.simulation) {
      throw new Error(`Evaluation references a simulation receipt without a bound simulator protocol`)
    }
    if (evaluation.integrityReceiptID && !contract.integrity) {
      throw new Error(`Evaluation references an integrity receipt without a bound runtime integrity protocol`)
    }
    if (contract.integrity && evaluation.status === "passed" && final(evaluation) && !evaluation.integrityReceiptID) {
      throw new Error(`A passing final evaluation must reference a runtime integrity receipt`)
    }
    if (evaluation.integrityReceiptID) {
      await HarnessIntegrity.assert({
        contract,
        receiptID: evaluation.integrityReceiptID,
        subject:
          evaluation.subject?.type === "candidate"
            ? { type: "candidate", id: evaluation.subject.id }
            : { type: "run", id: contract.runID },
        requirePassed: evaluation.status === "passed" && final(evaluation),
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
      })
    }
    if (evaluation.evolutionReceiptID && !contract.evolution) {
      throw new Error(`Evaluation references an evolution receipt without a bound evolution trace protocol`)
    }
    if (evaluation.evolutionReceiptID && evaluation.subject?.type !== "candidate") {
      throw new Error(`Only a candidate evaluation may reference an evolution receipt`)
    }
    if (
      contract.evolution &&
      evaluation.subject?.type === "candidate" &&
      evaluation.status === "passed" &&
      final(evaluation) &&
      !evaluation.evolutionReceiptID
    ) {
      throw new Error(`A passing final candidate evaluation must reference an evolution trace receipt`)
    }
    if (evaluation.evolutionReceiptID && evaluation.subject?.type === "candidate") {
      await HarnessEvolution.assert({
        contract,
        receiptID: evaluation.evolutionReceiptID,
        candidateID: evaluation.subject.id,
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
      })
    }
    if (evaluation.interventionReceiptID && !contract.interventions) {
      throw new Error(`Evaluation references an intervention receipt without a bound intervention protocol`)
    }
    if (evaluation.interventionReceiptID && evaluation.subject?.type !== "candidate") {
      throw new Error(`Only a candidate evaluation may reference an intervention receipt`)
    }
    if (evaluation.interventionReceiptID && !evaluation.evolutionReceiptID) {
      throw new Error(`An intervention-bearing evaluation must reference its exact evolution receipt`)
    }
    if (
      contract.interventions?.requiredForPromotion &&
      evaluation.subject?.type === "candidate" &&
      evaluation.status === "passed" &&
      final(evaluation) &&
      !evaluation.interventionReceiptID
    ) {
      throw new Error(`A passing final candidate evaluation must reference a controlled intervention receipt`)
    }
    if (evaluation.interventionReceiptID && evaluation.subject?.type === "candidate") {
      await HarnessIntervention.assert({
        contract,
        receiptID: evaluation.interventionReceiptID,
        candidateID: evaluation.subject.id,
        evolutionReceiptID: evaluation.evolutionReceiptID!,
        requirePassed: evaluation.status === "passed" && final(evaluation),
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
      })
    }
    if (contract.simulation && evaluation.status === "passed" && final(evaluation) && !evaluation.simulationReceiptID) {
      throw new Error(`A passing final simulation evaluation must reference a simulator validation receipt`)
    }
    if (evaluation.simulationReceiptID) {
      await HarnessSimulation.assert({
        contract,
        receiptID: evaluation.simulationReceiptID,
        candidateID: evaluation.subject?.type === "candidate" ? evaluation.subject.id : undefined,
        requirePassed: evaluation.status === "passed" && final(evaluation),
        evaluatedAt: evaluation.evaluatedAt,
      })
    }
    if (evaluation.evaluatorAuditReceiptID && !contract.evaluatorAudit) {
      throw new Error(`Evaluation references an auditor receipt without a bound evaluator audit protocol`)
    }
    if (
      contract.evaluatorAudit &&
      evaluation.status === "passed" &&
      final(evaluation) &&
      !evaluation.evaluatorAuditReceiptID
    ) {
      throw new Error(`A passing final evaluation must reference a qualified evaluator audit receipt`)
    }
    if (evaluation.evaluatorAuditReceiptID) {
      await HarnessJudge.assert({
        contract,
        receiptID: evaluation.evaluatorAuditReceiptID,
        recordedAt: evaluation.recordedAt!,
        requirePassed: evaluation.status === "passed" && final(evaluation),
      })
    }
    if (evaluation.semanticReceiptID && !contract.semanticAudit) {
      throw new Error(`Evaluation references a semantic receipt without a bound semantic audit protocol`)
    }
    if (
      contract.semanticAudit &&
      evaluation.status === "passed" &&
      final(evaluation) &&
      !evaluation.semanticReceiptID
    ) {
      throw new Error(`A passing final evaluation must reference a semantic audit receipt`)
    }
    if (evaluation.semanticReceiptID) {
      await HarnessSemantic.assert({
        contract,
        receiptID: evaluation.semanticReceiptID,
        subject:
          evaluation.subject?.type === "candidate"
            ? { type: "candidate", id: evaluation.subject.id }
            : { type: "run", id: contract.runID },
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
        requirePassed: evaluation.status === "passed" && final(evaluation),
      })
    }
    if (evaluation.replicationReceiptID && !contract.replication) {
      throw new Error(`Evaluation references a replication receipt without a bound replicated evaluation protocol`)
    }
    if (
      contract.replication &&
      evaluation.status === "passed" &&
      final(evaluation) &&
      !evaluation.replicationReceiptID
    ) {
      throw new Error(`A passing final evaluation must reference a replicated evaluation receipt`)
    }
    if (evaluation.replicationReceiptID) {
      await HarnessReplication.assert({
        contract,
        receiptID: evaluation.replicationReceiptID,
        subject:
          evaluation.subject?.type === "candidate"
            ? { type: "candidate", id: evaluation.subject.id }
            : { type: "run", id: contract.runID },
        score: evaluation.score,
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
        requirePassed: evaluation.status === "passed" && final(evaluation),
      })
    }
    if (evaluation.auditReceiptID && !contract.audit) {
      throw new Error(`Evaluation references an active audit receipt without a bound active audit protocol`)
    }
    if (
      contract.audit?.promotionRequired &&
      evaluation.status === "passed" &&
      final(evaluation) &&
      !evaluation.auditReceiptID
    ) {
      throw new Error(`A passing final evaluation must reference a qualified active audit receipt`)
    }
    if (evaluation.auditReceiptID) {
      const { HarnessAudit } = await import("./audit")
      await HarnessAudit.assert({
        contract,
        receiptID: evaluation.auditReceiptID,
        subject:
          evaluation.subject?.type === "candidate"
            ? { type: "candidate", id: evaluation.subject.id }
            : { type: "run", id: contract.runID },
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
        requireQualified: evaluation.status === "passed" && final(evaluation),
      })
    }
    if (evaluation.failureDiscoveryReceiptID && !contract.failureDiscovery) {
      throw new Error(`Evaluation references a failure discovery receipt without a bound protocol`)
    }
    if (evaluation.failureDiscoveryReceiptID) {
      const { HarnessFailure } = await import("./failure")
      await HarnessFailure.assert({
        contract,
        receiptID: evaluation.failureDiscoveryReceiptID,
        subject: evaluation.subject ?? { type: "run", id: evaluation.runID },
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
      })
    }
    if (evaluation.synthesisReceiptID && !contract.synthesis) {
      throw new Error(`Evaluation references a synthesis receipt without a bound scientific synthesis protocol`)
    }
    if (contract.synthesis && evaluation.status === "passed" && final(evaluation) && !evaluation.synthesisReceiptID) {
      throw new Error(`A passing final evaluation must reference a scientific synthesis receipt`)
    }
    if (evaluation.synthesisReceiptID) {
      const { HarnessSynthesis } = await import("./synthesis")
      await HarnessSynthesis.assert({
        contract,
        receiptID: evaluation.synthesisReceiptID,
        subject: evaluation.subject ?? { type: "run", id: evaluation.runID },
        score: evaluation.score,
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
        requirePassed: evaluation.status === "passed" && final(evaluation),
      })
    }
    if (evaluation.autonomyReceiptID && !contract.autonomy) {
      throw new Error(`Evaluation references an autonomy receipt without a bound human-AI autonomy protocol`)
    }
    if (contract.autonomy && evaluation.status === "passed" && final(evaluation) && !evaluation.autonomyReceiptID) {
      throw new Error(`A passing final evaluation must reference a human-AI autonomy receipt`)
    }
    if (evaluation.autonomyReceiptID) {
      const { HarnessAutonomy } = await import("./autonomy")
      await HarnessAutonomy.assert({
        contract,
        receiptID: evaluation.autonomyReceiptID,
        subject: evaluation.subject ?? { type: "run", id: evaluation.runID },
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
        requirePassed: evaluation.status === "passed" && final(evaluation),
      })
    }
    if (evaluation.proofReceiptID && !contract.formalProof) {
      throw new Error(`Evaluation references a proof receipt without a bound formal proof protocol`)
    }
    if (contract.formalProof && evaluation.status === "passed" && final(evaluation) && !evaluation.proofReceiptID) {
      throw new Error(`A passing final evaluation must reference a formal proof receipt`)
    }
    if (evaluation.proofReceiptID) {
      const { HarnessFormal } = await import("./formal")
      await HarnessFormal.assert({
        contract,
        receiptID: evaluation.proofReceiptID,
        subject: evaluation.subject ?? { type: "run", id: evaluation.runID },
        evaluatedAt: evaluation.evaluatedAt,
        recordedAt: evaluation.recordedAt!,
        requirePassed: evaluation.status === "passed" && final(evaluation),
      })
    }
    if (evaluation.status === "passed" && final(evaluation)) {
      HarnessDomain.assert(contract.packs ?? [], evaluation.checks)
    }
    await JsonStore.update(file(evaluation.sessionID), (data) => {
      const current = state(data)
      const id = key(evaluation)
      const existing = current.items[id]
      const prior = existing ? structuredClone(existing) : undefined
      const retry = structuredClone(evaluation)
      if (prior) delete prior.recordedAt
      delete retry.recordedAt
      if (prior && JSON.stringify(prior) === JSON.stringify(retry)) return current
      if (existing) throw new Error(`Evaluation for ${id} is immutable once recorded`)
      if (stage && plan) {
        const index = plan.findIndex((item) => item.id === stage.id)
        const prior = plan
          .slice(0, index)
          .map(
            (item) =>
              current.items[key({ subject: evaluation.subject, fidelity: { stage: item.id, final: item.final } })],
          )
        if (prior.some((item) => !item || !passed(item))) {
          throw new Error(`Evaluation cannot advance before every prior fidelity stage passes`)
        }
      }
      return State.parse({
        ...current,
        items: { ...current.items, [id]: evaluation },
        order: [...current.order, id],
      })
    })
    const stored = (await list(evaluation.sessionID)).find((item) => key(item) === key(evaluation))
    if (!stored) throw new Error(`Evaluation was not durable after recording`)
    return stored
  }

  export async function list(sessionID: string): Promise<Info[]> {
    const data = await JsonStore.read(file(sessionID))
    const parsed = state(data)
    return parsed.order.map((id) => parsed.items[id]!)
  }

  export async function read(sessionID: string, subject?: Info["subject"]): Promise<Info | null> {
    const items = await list(sessionID)
    if (!subject) return items.at(-1) ?? null
    return items.findLast((item) => item.subject?.type === subject.type && item.subject.id === subject.id) ?? null
  }
}
