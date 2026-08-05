import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessJudge } from "./judge"

export namespace HarnessSynthesis {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

  export const Subject = z
    .object({
      type: z.enum(["run", "candidate"]),
      id: z.string().min(1).max(240),
    })
    .strict()
  export type Subject = z.infer<typeof Subject>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      evaluatorToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  const Fact = z
    .object({
      id: ID,
      commitment: Hash,
    })
    .strict()

  export const GeneratedFact = Fact.extend({
    verdict: z.enum(["supported", "contradicted", "unsupported", "judge_error"]),
    evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
  }).strict()
  export type GeneratedFact = z.infer<typeof GeneratedFact>

  export const ReferenceFact = Fact.extend({
    coverage: z.enum(["covered", "missed", "judge_error"]),
    evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
  }).strict()
  export type ReferenceFact = z.infer<typeof ReferenceFact>

  export const Violation = z.enum([
    "forbidden_domain",
    "reference_title",
    "post_cutoff",
    "unknown_date",
    "duplicate_output",
  ])
  export type Violation = z.infer<typeof Violation>

  const ToolInput = z
    .object({
      sequence: z.number().int().positive(),
      tool: HarnessContract.SynthesisTool,
      requestSHA256: Hash,
      responseSHA256: Hash,
      sourceSHA256: Hash,
      publishedAt: z.iso.date().optional(),
      matches: z
        .object({
          forbiddenDomain: z.boolean(),
          referenceTitle: z.boolean(),
        })
        .strict(),
      decision: z.enum(["allowed", "blocked"]),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  export const ToolEvent = ToolInput.extend({
    eventID: Hash,
    violations: z.array(Violation).max(Violation.options.length),
  }).strict()
  export type ToolEvent = z.infer<typeof ToolEvent>

  const Decomposition = z
    .object({
      status: z.enum(["passed", "failed"]),
      outputSHA256: Hash.optional(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.status === "passed" && !value.outputSHA256) {
        ctx.addIssue({ code: "custom", path: ["outputSHA256"], message: "A passing decomposition needs an output" })
      }
      if (value.status === "failed" && value.outputSHA256) {
        ctx.addIssue({ code: "custom", path: ["outputSHA256"], message: "A failed decomposition has no output" })
      }
    })

  export const Submit = Access.extend({
    subject: Subject,
    conclusionSHA256: Hash,
    evaluatorAuditReceiptID: Hash,
    trace: z
      .object({
        owner: z.literal("evaluator_runtime"),
        complete: z.literal(true),
        schemaSHA256: Hash,
        filterPolicySHA256: Hash,
        events: z.array(ToolInput).max(10_000),
      })
      .strict(),
    decomposition: Decomposition,
    generatedFacts: z.array(GeneratedFact).max(512),
    referenceFacts: z.array(ReferenceFact).min(1).max(2_048),
    evaluatedAt: z.number().int().positive(),
  }).strict()
  export type Submit = z.infer<typeof Submit>

  const Violations = z.record(Violation, z.number().int().nonnegative())

  export const Metrics = z
    .object({
      toolEvents: z.number().int().nonnegative(),
      allowedSources: z.number().int().nonnegative(),
      blockedSources: z.number().int().nonnegative(),
      violations: Violations,
      generatedFacts: z.number().int().nonnegative(),
      supported: z.number().int().nonnegative(),
      contradicted: z.number().int().nonnegative(),
      unsupported: z.number().int().nonnegative(),
      precisionJudgeErrors: z.number().int().nonnegative(),
      referenceFacts: z.number().int().positive(),
      covered: z.number().int().nonnegative(),
      missed: z.number().int().nonnegative(),
      recallJudgeErrors: z.number().int().nonnegative(),
      precision: z.number().min(0).max(1).optional(),
      recall: z.number().min(0).max(1).optional(),
      f1: z.number().min(0).max(1).optional(),
    })
    .strict()
  export type Metrics = z.infer<typeof Metrics>

  export const Receipt = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("scientific-synthesis-receipt-v1"),
      receiptID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      protocolSHA256: Hash,
      subject: Subject,
      conclusionSHA256: Hash,
      evaluatorAuditReceiptID: Hash,
      traceSHA256: Hash,
      events: z.array(ToolEvent).max(10_000),
      decomposition: Decomposition,
      generatedFacts: z.array(GeneratedFact).max(512),
      referenceFacts: z.array(ReferenceFact).min(1).max(2_048),
      metrics: Metrics,
      status: z.enum(["passed", "failed", "inconclusive"]),
      failures: z.array(z.string().min(1).max(500)).max(64),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const stable = structuredClone(value) as Record<string, unknown>
      delete stable.receiptID
      delete stable.recordedAt
      if (digest(stable) === value.receiptID) return
      ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Scientific synthesis receipt hash is invalid" })
    })
  export type Receipt = z.infer<typeof Receipt>

  export function prompt(contract: HarnessContract.Info) {
    const protocol = contract.synthesis
    if (!protocol) return ""
    return [
      "<clean-room-scientific-synthesis-policy>",
      "Synthesize the conclusion from admissible evidence; the hidden reference and atomic answer facts remain evaluator-private.",
      `Use only the declared retrieval tools (${protocol.tools.join(", ")}) and at most ${protocol.maxToolEvents} tool events.`,
      `Treat ${protocol.cutoff} as the inclusive publication cutoff. Do not use undated or post-cutoff sources, forbidden reference domains, direct reference-title matches, or repeated cached outputs.`,
      `Produce at least ${protocol.minGeneratedFacts} atomic facts. The external evaluator will derive factual precision, reference-fact recall, contradiction-adjusted F1, and require precision>=${protocol.minPrecision}, recall>=${protocol.minRecall}, F1>=${protocol.minF1}.`,
      "Do not retrieve, infer, or ask for the hidden reference, fact manifest, salt, judge prompts, blocked outputs, or evaluator capabilities. Judge failures are inconclusive, not evidence against the answer.",
      "</clean-room-scientific-synthesis-policy>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    return contract ? prompt(contract) : ""
  }

  const root = path.join(Global.Path.data, "harness", "syntheses")
  const receiptFile = (receiptID: string) => path.join(root, "receipts", `${receiptID}.json`)
  const subjectFile = (sessionID: string, subject: Subject) =>
    path.join(
      root,
      "subjects",
      encodeURIComponent(sessionID),
      `${encodeURIComponent(`${subject.type}:${subject.id}`)}.json`,
    )

  export function referenceManifest(input: Array<Pick<ReferenceFact, "id" | "commitment">>) {
    return digest(input.map((item) => ({ id: item.id, commitment: item.commitment })))
  }

  const ordered = (items: Array<{ id: string }>) =>
    items.every((item, index) => !index || items[index - 1]!.id < item.id)

  const unique = (items: Array<{ id: string; commitment: string }>) =>
    new Set(items.map((item) => item.id)).size === items.length &&
    new Set(items.map((item) => item.commitment)).size === items.length

  async function born(contract: HarnessContract.Info, subject: Subject) {
    if (subject.type === "run") {
      if (subject.id !== contract.runID) {
        throw new Error(`Scientific synthesis run subject does not match its bound contract`)
      }
      return contract.createdAt
    }
    const state = await import("./search")
      .then((module) => module.HarnessSearch.read(contract.sessionID))
      .catch(() => null)
    const candidate = state?.runID === contract.runID ? state.candidates[subject.id] : undefined
    if (!candidate) throw new Error(`Scientific synthesis candidate does not exist in the bound search`)
    return candidate.createdAt
  }

  function events(input: z.infer<typeof ToolInput>[], protocol: HarnessContract.ScientificSynthesis) {
    const prior = new Set<string>()
    return input.map((item, index) => {
      if (item.sequence !== index + 1) throw new Error(`Scientific synthesis tool trace must be contiguous from one`)
      if (!protocol.tools.includes(item.tool)) {
        throw new Error(`Scientific synthesis used undeclared tool ${item.tool}`)
      }
      const violations = Violation.options.filter((violation) => {
        if (violation === "forbidden_domain") return item.matches.forbiddenDomain
        if (violation === "reference_title") return item.matches.referenceTitle
        if (violation === "post_cutoff") return Boolean(item.publishedAt && item.publishedAt > protocol.cutoff)
        if (violation === "unknown_date") return !item.publishedAt
        return prior.has(item.responseSHA256)
      })
      const decision = violations.length ? "blocked" : "allowed"
      if (item.decision !== decision) {
        throw new Error(
          `Scientific synthesis tool event ${item.sequence} changed its backend-derived clean-room decision`,
        )
      }
      prior.add(item.responseSHA256)
      const stable = { ...item, violations }
      return ToolEvent.parse({ ...stable, eventID: digest(stable) })
    })
  }

  function assess(input: {
    protocol: HarnessContract.ScientificSynthesis
    trace: ToolEvent[]
    decomposition: z.infer<typeof Decomposition>
    generated: GeneratedFact[]
    reference: ReferenceFact[]
  }) {
    const supported = input.generated.filter((item) => item.verdict === "supported").length
    const contradicted = input.generated.filter((item) => item.verdict === "contradicted").length
    const unsupported = input.generated.filter((item) => item.verdict === "unsupported").length
    const precisionJudgeErrors = input.generated.filter((item) => item.verdict === "judge_error").length
    const covered = input.reference.filter((item) => item.coverage === "covered").length
    const missed = input.reference.filter((item) => item.coverage === "missed").length
    const recallJudgeErrors = input.reference.filter((item) => item.coverage === "judge_error").length
    const validPrecision =
      input.decomposition.status === "passed" && !precisionJudgeErrors && input.generated.length > 0
    const validRecall = !recallJudgeErrors
    const precision = validPrecision
      ? (supported / input.generated.length) * (1 - contradicted / input.generated.length)
      : undefined
    const recall = validRecall ? covered / input.reference.length : undefined
    const f1 =
      precision === undefined || recall === undefined
        ? undefined
        : precision + recall
          ? (2 * precision * recall) / (precision + recall)
          : 0
    const violations = Object.fromEntries(
      Violation.options.map((violation) => [
        violation,
        input.trace.filter((item) => item.violations.includes(violation)).length,
      ]),
    ) as Record<Violation, number>
    const metrics = Metrics.parse({
      toolEvents: input.trace.length,
      allowedSources: input.trace.filter((item) => item.decision === "allowed").length,
      blockedSources: input.trace.filter((item) => item.decision === "blocked").length,
      violations,
      generatedFacts: input.generated.length,
      supported,
      contradicted,
      unsupported,
      precisionJudgeErrors,
      referenceFacts: input.reference.length,
      covered,
      missed,
      recallJudgeErrors,
      precision,
      recall,
      f1,
    })
    const inconclusive = [
      ...(input.decomposition.status === "failed" ? ["atomic fact decomposition failed"] : []),
      ...(precisionJudgeErrors ? [`${precisionJudgeErrors} precision judgments failed`] : []),
      ...(recallJudgeErrors ? [`${recallJudgeErrors} recall judgments failed`] : []),
    ]
    if (inconclusive.length) return { metrics, status: "inconclusive" as const, failures: inconclusive }
    const failures = [
      ...(precision! < input.protocol.minPrecision
        ? [`factual precision ${precision} is below ${input.protocol.minPrecision}`]
        : []),
      ...(recall! < input.protocol.minRecall ? [`factual recall ${recall} is below ${input.protocol.minRecall}`] : []),
      ...(f1! < input.protocol.minF1 ? [`factual F1 ${f1} is below ${input.protocol.minF1}`] : []),
    ]
    return { metrics, status: failures.length ? ("failed" as const) : ("passed" as const), failures }
  }

  function verify(receipt: Receipt, protocol: HarnessContract.ScientificSynthesis) {
    if (
      !ordered(receipt.referenceFacts) ||
      !unique(receipt.referenceFacts) ||
      receipt.referenceFacts.length !== protocol.referenceFactCount ||
      referenceManifest(receipt.referenceFacts) !== protocol.referenceFactsSHA256
    ) {
      throw new Error(`Scientific synthesis receipt changed its frozen reference facts`)
    }
    if (!ordered(receipt.generatedFacts) || !unique(receipt.generatedFacts)) {
      throw new Error(`Scientific synthesis receipt changed its generated fact manifest`)
    }
    if (
      (receipt.decomposition.status === "passed" && receipt.generatedFacts.length < protocol.minGeneratedFacts) ||
      (receipt.decomposition.status === "failed" && receipt.generatedFacts.length > 0)
    ) {
      throw new Error(`Scientific synthesis receipt changed its decomposition outcome`)
    }
    const trace = events(
      receipt.events.map((item) =>
        ToolInput.parse(
          Object.fromEntries(Object.entries(item).filter(([key]) => key !== "eventID" && key !== "violations")),
        ),
      ),
      protocol,
    )
    if (!same(trace, receipt.events) || digest(trace) !== receipt.traceSHA256) {
      throw new Error(`Scientific synthesis receipt does not match its backend-replayed retrieval trace`)
    }
    const result = assess({
      protocol,
      trace,
      decomposition: receipt.decomposition,
      generated: receipt.generatedFacts,
      reference: receipt.referenceFacts,
    })
    if (
      !same(result.metrics, receipt.metrics) ||
      result.status !== receipt.status ||
      !same(result.failures, receipt.failures)
    ) {
      throw new Error(`Scientific synthesis receipt does not match backend-derived factuality metrics`)
    }
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    if (value.sessionID !== contract.sessionID) {
      throw new Error(`Scientific synthesis session does not match its bound harness contract`)
    }
    const protocol = contract.synthesis
    if (!protocol) throw new Error(`Harness contract does not require scientific synthesis validation`)
    if (value.trace.schemaSHA256 !== protocol.traceSchemaSHA256) {
      throw new Error(`Scientific synthesis trace schema does not match the bound protocol`)
    }
    if (value.trace.filterPolicySHA256 !== protocol.filterPolicySHA256) {
      throw new Error(`Scientific synthesis filter policy does not match the bound protocol`)
    }
    if (value.trace.events.length > protocol.maxToolEvents) {
      throw new Error(`Scientific synthesis tool trace exceeds its frozen event budget`)
    }
    if (!ordered(value.referenceFacts) || !unique(value.referenceFacts)) {
      throw new Error(`Scientific synthesis reference facts must be unique and sorted by ID`)
    }
    if (value.referenceFacts.length !== protocol.referenceFactCount) {
      throw new Error(`Scientific synthesis reference fact count does not match the bound protocol`)
    }
    if (referenceManifest(value.referenceFacts) !== protocol.referenceFactsSHA256) {
      throw new Error(`Scientific synthesis reference facts do not match the hidden manifest commitment`)
    }
    if (!ordered(value.generatedFacts) || !unique(value.generatedFacts)) {
      throw new Error(`Scientific synthesis generated facts must be unique and sorted by ID`)
    }
    if (value.decomposition.status === "passed" && value.generatedFacts.length < protocol.minGeneratedFacts) {
      throw new Error(`Scientific synthesis decomposition produced too few atomic facts`)
    }
    if (value.decomposition.status === "failed" && value.generatedFacts.length) {
      throw new Error(`A failed scientific synthesis decomposition cannot contain generated facts`)
    }
    const recordedAt = Date.now()
    const createdAt = await born(contract, value.subject)
    if (value.evaluatedAt < createdAt || value.evaluatedAt > recordedAt) {
      throw new Error(`Scientific synthesis evaluation falls outside its bound subject interval`)
    }
    await HarnessJudge.assert({
      contract,
      receiptID: value.evaluatorAuditReceiptID,
      recordedAt,
      requirePassed: true,
    })
    const trace = events(value.trace.events, protocol)
    const result = assess({
      protocol,
      trace,
      decomposition: value.decomposition,
      generated: value.generatedFacts,
      reference: value.referenceFacts,
    })
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "scientific-synthesis-receipt-v1" as const,
      runID: contract.runID,
      sessionID: contract.sessionID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
      subject: value.subject,
      conclusionSHA256: value.conclusionSHA256,
      evaluatorAuditReceiptID: value.evaluatorAuditReceiptID,
      traceSHA256: digest(trace),
      events: trace,
      decomposition: value.decomposition,
      generatedFacts: value.generatedFacts,
      referenceFacts: value.referenceFacts,
      metrics: result.metrics,
      status: result.status,
      failures: result.failures,
      evaluatedAt: value.evaluatedAt,
    }
    const receipt = Receipt.parse({ ...stable, receiptID: digest(stable), recordedAt })
    const claimed = await JsonStore.read(subjectFile(receipt.sessionID, receipt.subject))
    if (Object.keys(claimed).length) {
      const current = Receipt.parse(claimed)
      if (current.receiptID !== receipt.receiptID) {
        throw new Error(`Scientific synthesis subject already has a canonical receipt`)
      }
    }
    await JsonStore.update(receiptFile(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Scientific synthesis receipt is immutable once recorded`)
    })
    await JsonStore.update(subjectFile(receipt.sessionID, receipt.subject), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Scientific synthesis subject already has a canonical receipt`)
    })
    const saved = await readReceipt(receipt.receiptID)
    if (!saved) throw new Error(`Scientific synthesis receipt was not durable after recording`)
    return saved
  }

  export async function readReceipt(receiptID: string) {
    const id = Hash.parse(receiptID)
    const parsed = Receipt.safeParse(await JsonStore.read(receiptFile(id)))
    if (!parsed.success || parsed.data.receiptID !== id) return null
    const canonical = Receipt.safeParse(await JsonStore.read(subjectFile(parsed.data.sessionID, parsed.data.subject)))
    if (!canonical.success || canonical.data.receiptID !== id || !same(canonical.data, parsed.data)) return null
    return parsed.data
  }

  export async function read(receiptID: string, contract: HarnessContract.Info) {
    const receipt = await readReceipt(receiptID)
    if (!receipt || receipt.sessionID !== contract.sessionID) {
      throw new Error(`Unknown scientific synthesis receipt ${receiptID}`)
    }
    const protocol = contract.synthesis
    if (!protocol || receipt.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Scientific synthesis receipt belongs to a different harness run`)
    }
    verify(receipt, protocol)
    return receipt
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
    const receipt = await readReceipt(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt scientific synthesis receipt ${input.receiptID}`)
    const protocol = input.contract.synthesis
    if (!protocol) throw new Error(`Evaluation cites a synthesis receipt without a bound protocol`)
    if (
      receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract) ||
      receipt.protocolSHA256 !== digest(protocol) ||
      receipt.sessionID !== input.contract.sessionID ||
      receipt.runID !== input.contract.runID
    ) {
      throw new Error(`Scientific synthesis receipt belongs to a different harness run`)
    }
    verify(receipt, protocol)
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Scientific synthesis receipt belongs to a different evaluation subject`)
    }
    if (receipt.evaluatedAt > input.evaluatedAt || receipt.recordedAt > input.recordedAt) {
      throw new Error(`Evaluation predates its scientific synthesis receipt`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A passing final evaluation requires a passing scientific synthesis receipt`)
    }
    if (input.requirePassed && (input.score === undefined || input.score !== receipt.metrics.f1)) {
      throw new Error(`A passing scientific synthesis score must equal the backend-derived factual F1`)
    }
    await HarnessJudge.assert({
      contract: input.contract,
      receiptID: receipt.evaluatorAuditReceiptID,
      recordedAt: input.recordedAt,
      requirePassed: input.requirePassed,
    })
    return receipt
  }
}
