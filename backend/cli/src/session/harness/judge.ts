import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessJudge {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  export const Decision = z.enum(["accept", "reject", "abstain"])
  export type Decision = z.infer<typeof Decision>

  export const Case = z
    .object({
      id: z.string().min(1).max(240),
      commitment: Hash,
      kind: z.enum(["clean", "fault"]),
      fault: HarnessContract.EvaluatorFault.optional(),
      decision: Decision,
      failureProbability: z.number().min(0).max(1),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.kind === "fault" && !value.fault) {
        ctx.addIssue({ code: "custom", path: ["fault"], message: "A fault case must name its hidden fault class" })
      }
      if (value.kind === "clean" && value.fault) {
        ctx.addIssue({ code: "custom", path: ["fault"], message: "A clean case cannot name a fault class" })
      }
    })
  export type Case = z.infer<typeof Case>

  export function commitment(input: Array<Pick<Case, "id" | "commitment" | "kind" | "fault">>) {
    const manifest = input
      .map((item) => ({ id: item.id, commitment: item.commitment, kind: item.kind, fault: item.fault }))
      .toSorted((left, right) => left.id.localeCompare(right.id))
    return digest(manifest)
  }

  export const Submit = z
    .object({
      sessionID: z.string().min(1).max(240),
      auditorToken: Token,
      cases: z.array(Case).min(3).max(2_048),
    })
    .strict()
  export type Submit = z.input<typeof Submit>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      auditorToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  const Rate = z
    .object({
      cases: z.number().int().positive(),
      detected: z.number().int().nonnegative(),
      recall: z.number().min(0).max(1),
    })
    .strict()

  export const Receipt = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("evaluator-audit-receipt-v1"),
      receiptID: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1),
      evaluator: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          source: z.enum(["benchmark", "gate", "human", "external"]),
        })
        .strict(),
      auditor: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          source: z.enum(["benchmark", "gate", "human", "external"]),
        })
        .strict(),
      suite: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          commitmentSHA256: Hash,
        })
        .strict(),
      cases: z.array(Case).min(3).max(2_048),
      metrics: z
        .object({
          cases: z.number().int().min(3),
          cleanCases: z.number().int().positive(),
          faultCases: z.number().int().positive(),
          truePositive: z.number().int().nonnegative(),
          falseNegative: z.number().int().nonnegative(),
          trueNegative: z.number().int().nonnegative(),
          falsePositive: z.number().int().nonnegative(),
          sensitivity: z.number().min(0).max(1),
          specificity: z.number().min(0).max(1),
          balancedAccuracy: z.number().min(0).max(1),
          brierScore: z.number().min(0).max(1),
          perFault: z.partialRecord(HarnessContract.EvaluatorFault, Rate),
        })
        .strict(),
      status: z.enum(["passed", "failed"]),
      failures: z.array(z.string().min(1).max(500)).max(64),
      recordedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const stable = structuredClone(value) as Record<string, unknown>
      delete stable.receiptID
      delete stable.recordedAt
      if (digest(stable) === value.receiptID) return
      ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Evaluator audit receipt content hash is invalid" })
    })
  export type Receipt = z.infer<typeof Receipt>

  const root = path.join(Global.Path.data, "harness", "judges")
  const file = (receiptID: string) => path.join(root, `${receiptID}.json`)

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const protocol = contract.evaluatorAudit
    if (!protocol) throw new Error(`Harness contract does not require evaluator qualification`)
    if (value.sessionID !== contract.sessionID) throw new Error(`Evaluator audit session does not match its contract`)
    const cases = value.cases.toSorted((left, right) => left.id.localeCompare(right.id))
    if (new Set(cases.map((item) => item.id)).size !== cases.length) {
      throw new Error(`Evaluator audit case identities must be unique`)
    }
    if (new Set(cases.map((item) => item.commitment)).size !== cases.length) {
      throw new Error(`Evaluator audit case commitments must be unique`)
    }
    if (commitment(cases) !== protocol.suite.commitmentSHA256) {
      throw new Error(`Evaluator audit cases do not match the precommitted hidden suite`)
    }
    const clean = cases.filter((item) => item.kind === "clean")
    const faults = cases.filter((item) => item.kind === "fault")
    if (clean.length < protocol.minCleanCases) {
      throw new Error(`Evaluator audit requires at least ${protocol.minCleanCases} clean cases`)
    }
    for (const fault of protocol.requiredFaults) {
      const count = faults.filter((item) => item.fault === fault).length
      if (count >= protocol.minCasesPerFault) continue
      throw new Error(`Evaluator audit requires at least ${protocol.minCasesPerFault} ${fault} cases`)
    }
    const truePositive = faults.filter((item) => item.decision === "reject").length
    const falseNegative = faults.length - truePositive
    const trueNegative = clean.filter((item) => item.decision === "accept").length
    const falsePositive = clean.length - trueNegative
    const sensitivity = truePositive / faults.length
    const specificity = trueNegative / clean.length
    const balancedAccuracy = (sensitivity + specificity) / 2
    const brierScore =
      cases.reduce((sum, item) => sum + (item.failureProbability - (item.kind === "fault" ? 1 : 0)) ** 2, 0) /
      cases.length
    const perFault = Object.fromEntries(
      protocol.requiredFaults.map((fault) => {
        const items = faults.filter((item) => item.fault === fault)
        const detected = items.filter((item) => item.decision === "reject").length
        return [fault, { cases: items.length, detected, recall: detected / items.length }]
      }),
    )
    const failures = [
      ...(sensitivity < protocol.minSensitivity
        ? [`sensitivity ${sensitivity} is below ${protocol.minSensitivity}`]
        : []),
      ...(specificity < protocol.minSpecificity
        ? [`specificity ${specificity} is below ${protocol.minSpecificity}`]
        : []),
      ...(balancedAccuracy < protocol.minBalancedAccuracy
        ? [`balanced accuracy ${balancedAccuracy} is below ${protocol.minBalancedAccuracy}`]
        : []),
      ...(brierScore > protocol.maxBrierScore ? [`Brier score ${brierScore} exceeds ${protocol.maxBrierScore}`] : []),
      ...Object.entries(perFault).flatMap(([fault, rate]) =>
        rate.recall < protocol.minFaultRecall
          ? [`${fault} recall ${rate.recall} is below ${protocol.minFaultRecall}`]
          : [],
      ),
    ]
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "evaluator-audit-receipt-v1" as const,
      protocolSHA256: digest(protocol),
      sourceSessionID: contract.sessionID,
      evaluator: {
        name: contract.benchmark.evaluator,
        version: contract.benchmark.evaluatorVersion!,
        source: contract.benchmark.evaluatorSource!,
      },
      auditor: protocol.auditor,
      suite: protocol.suite,
      cases,
      metrics: {
        cases: cases.length,
        cleanCases: clean.length,
        faultCases: faults.length,
        truePositive,
        falseNegative,
        trueNegative,
        falsePositive,
        sensitivity,
        specificity,
        balancedAccuracy,
        brierScore,
        perFault,
      },
      status: failures.length ? ("failed" as const) : ("passed" as const),
      failures,
    }
    const receipt = Receipt.parse({ ...stable, receiptID: digest(stable), recordedAt: Date.now() })
    await JsonStore.update(file(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Evaluator audit receipt is immutable once recorded`)
    })
    const stored = await read(receipt.receiptID)
    if (!stored) throw new Error(`Evaluator audit receipt was not durable after recording`)
    return stored
  }

  export async function read(receiptID: string) {
    const data = await JsonStore.read(file(Hash.parse(receiptID)))
    const parsed = Receipt.safeParse(data)
    return parsed.success ? parsed.data : null
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    recordedAt: number
    requirePassed: boolean
  }) {
    const receipt = await read(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt evaluator audit receipt ${input.receiptID}`)
    const protocol = input.contract.evaluatorAudit
    if (!protocol) throw new Error(`Evaluation cites an auditor receipt without a bound evaluator audit protocol`)
    if (receipt.protocolSHA256 !== digest(protocol)) {
      throw new Error(`Evaluator audit receipt does not match the bound qualification protocol`)
    }
    if (
      receipt.evaluator.name !== input.contract.benchmark.evaluator ||
      receipt.evaluator.version !== input.contract.benchmark.evaluatorVersion ||
      receipt.evaluator.source !== input.contract.benchmark.evaluatorSource
    ) {
      throw new Error(`Evaluator audit receipt qualifies a different evaluator`)
    }
    if (receipt.recordedAt > input.recordedAt) {
      throw new Error(`Evaluation predates its evaluator audit receipt`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A passing final evaluation requires a passing evaluator audit receipt`)
    }
    return receipt
  }
}
