import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessSemantic {
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

  const Criterion = z
    .object({
      id: z.string().min(1).max(100),
      status: z.enum(["passed", "failed", "inconclusive"]),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  const Shortcut = z
    .object({
      id: z.string().min(1).max(100),
      observed: z.boolean(),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(32),
    })
    .strict()

  export const Review = z
    .object({
      actor: z.string().min(1).max(200),
      sessionID: z.string().min(1).max(240),
      correctness: z.enum(["passed", "failed", "inconclusive"]),
      alignment: z.enum(["intended", "reasonable_alternative", "misinterpreted", "ambiguous"]),
      novelty: HarnessContract.Novelty,
      vacuous: z.boolean(),
      confidence: z.number().finite().min(0).max(1),
      criteria: z
        .array(Criterion)
        .min(1)
        .max(24)
        .refine(
          (items) => new Set(items.map((item) => item.id)).size === items.length,
          "Semantic review criterion IDs must be unique",
        ),
      shortcuts: z
        .array(Shortcut)
        .min(1)
        .max(24)
        .refine(
          (items) => new Set(items.map((item) => item.id)).size === items.length,
          "Semantic review shortcut IDs must be unique",
        ),
      literatureRefs: z.array(z.string().min(1).max(1_000)).max(32).default([]),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(64),
      summary: z.string().min(1).max(4_000),
      reviewedAt: z.number().int().positive(),
    })
    .strict()
  export type Review = z.infer<typeof Review>

  export const Submit = z
    .object({
      sessionID: z.string().min(1).max(240),
      reviewerToken: Token,
      subject: Subject,
      reviews: z.array(Review).min(2).max(5),
    })
    .strict()
  export type Submit = z.input<typeof Submit>

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      reviewerToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  const ReceiptBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("semantic-audit-receipt-v1"),
      receiptID: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1),
      subject: Subject,
      reviewer: z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          source: z.enum(["gate", "human", "external"]),
        })
        .strict(),
      scope: HarnessContract.SemanticAudit.shape.scope,
      reviews: z.array(Review).min(2).max(5),
      status: z.enum(["meaningful", "technical_only", "ambiguous", "failed"]),
      failures: z.array(z.string().min(1).max(500)).max(256),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(256),
      reviewedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()

  export const Receipt = ReceiptBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.receiptID
    if (digest(stable) === value.receiptID) return
    ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Semantic audit receipt content hash is invalid" })
  })
  export type Receipt = z.infer<typeof Receipt>

  const root = path.join(Global.Path.data, "harness", "semantics")
  const file = (receiptID: string) => path.join(root, `${receiptID}.json`)
  const rank: Record<HarnessContract.Novelty, number> = {
    not_required: -1,
    known: 0,
    rediscovery: 1,
    minor: 2,
    publication: 3,
    major: 4,
  }

  function derive(protocol: HarnessContract.SemanticAudit, reviews: Review[]) {
    const incorrect = reviews.flatMap((review) =>
      review.correctness === "failed" ? [`${review.actor}:correctness_failed`] : [],
    )
    const uncertain = reviews.flatMap((review) => [
      ...(review.correctness === "inconclusive" ? [`${review.actor}:correctness_inconclusive`] : []),
      ...(review.alignment === "ambiguous" ? [`${review.actor}:alignment_ambiguous`] : []),
      ...(review.confidence < protocol.minConfidence ? [`${review.actor}:low_confidence`] : []),
      ...review.criteria.flatMap((item) =>
        item.status === "inconclusive" ? [`${review.actor}:criterion_${item.id}_inconclusive`] : [],
      ),
    ])
    const technical = reviews.flatMap((review) => [
      ...(review.alignment === "misinterpreted" ? [`${review.actor}:problem_misinterpreted`] : []),
      ...(review.vacuous ? [`${review.actor}:vacuous_solution`] : []),
      ...review.criteria.flatMap((item) =>
        item.status === "failed" ? [`${review.actor}:criterion_${item.id}_failed`] : [],
      ),
      ...review.shortcuts.flatMap((item) => (item.observed ? [`${review.actor}:shortcut_${item.id}_observed`] : [])),
      ...(rank[review.novelty] < rank[protocol.scope.noveltyFloor]
        ? [`${review.actor}:novelty_${review.novelty}_below_${protocol.scope.noveltyFloor}`]
        : []),
    ])
    const status = incorrect.length
      ? ("failed" as const)
      : uncertain.length
        ? ("ambiguous" as const)
        : technical.length
          ? ("technical_only" as const)
          : ("meaningful" as const)
    return { status, failures: [...incorrect, ...uncertain, ...technical] }
  }

  function inspect(protocol: HarnessContract.SemanticAudit, input: Review[]) {
    if (input.length < protocol.minReviewers) {
      throw new Error(`Semantic review requires at least ${protocol.minReviewers} independent reviewers`)
    }
    const reviews = input.toSorted(
      (left, right) => left.actor.localeCompare(right.actor) || left.sessionID.localeCompare(right.sessionID),
    )
    if (new Set(reviews.map((item) => `${item.actor}\0${item.sessionID}`)).size !== reviews.length) {
      throw new Error(`Semantic reviewers must have unique actor-session identities`)
    }
    if (new Set(reviews.map((item) => item.actor)).size !== reviews.length) {
      throw new Error(`Semantic reviewers must use distinct actors`)
    }
    if (new Set(reviews.map((item) => item.sessionID)).size !== reviews.length) {
      throw new Error(`Semantic reviewers must use distinct sessions`)
    }
    const criteria = protocol.scope.criteria.map((item) => item.id).toSorted()
    const shortcuts = protocol.scope.forbiddenShortcuts.map((item) => item.id).toSorted()
    for (const review of reviews) {
      if (JSON.stringify(review.criteria.map((item) => item.id).toSorted()) !== JSON.stringify(criteria)) {
        throw new Error(`Semantic review criteria do not match the frozen problem scope`)
      }
      if (JSON.stringify(review.shortcuts.map((item) => item.id).toSorted()) !== JSON.stringify(shortcuts)) {
        throw new Error(`Semantic review shortcuts do not match the frozen problem scope`)
      }
      if (protocol.scope.noveltyFloor !== "not_required" && !review.literatureRefs.length) {
        throw new Error(`Novelty review requires literature evidence from the frozen corpus scope`)
      }
    }
    return { reviews, ...derive(protocol, reviews) }
  }

  function evidence(reviews: Review[]) {
    return [
      ...new Set(
        reviews.flatMap((review) => [
          ...review.evidence,
          ...review.literatureRefs,
          ...review.criteria.flatMap((item) => item.evidence),
          ...review.shortcuts.flatMap((item) => item.evidence),
        ]),
      ),
    ].toSorted()
  }

  async function born(contract: HarnessContract.Info, subject: Subject) {
    if (subject.type === "run") {
      if (subject.id !== contract.runID) throw new Error(`Semantic review run subject does not match its contract`)
      return contract.createdAt
    }
    const state = await import("./search")
      .then((module) => module.HarnessSearch.read(contract.sessionID))
      .catch(() => null)
    const candidate = state?.runID === contract.runID ? state.candidates[subject.id] : undefined
    if (!candidate) throw new Error(`Semantic review candidate does not exist in the bound search`)
    return candidate.createdAt
  }

  export function prompt(contract: HarnessContract.Info) {
    const protocol = contract.semanticAudit
    if (!protocol) return ""
    return [
      "<semantic-audit-scope>",
      "The evaluator froze this problem-meaning contract before execution. Treat it as evaluation policy, not as evidence that your answer passes it.",
      `Objective SHA-256: ${protocol.scope.objectiveSHA256}`,
      `Required meaning criteria (JSON): ${JSON.stringify(protocol.scope.criteria)}`,
      `Forbidden shortcuts (JSON): ${JSON.stringify(protocol.scope.forbiddenShortcuts)}`,
      `Literature scope: cutoff=${protocol.scope.literature.cutoff}; corpus_sha256=${protocol.scope.literature.corpusSHA256}`,
      `Minimum novelty: ${protocol.scope.noveltyFloor}`,
      `Independent review: at least ${protocol.minReviewers} reviewers at confidence >= ${protocol.minConfidence}`,
      "A technically valid, vacuous, misinterpreted, shortcut-dependent, or insufficiently novel answer cannot pass the final evaluation.",
      "Do not claim semantic compliance yourself; produce observable evidence for an independent panel.",
      "</semantic-audit-scope>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    return contract ? prompt(contract) : ""
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const protocol = contract.semanticAudit
    if (!protocol) throw new Error(`Harness contract does not require semantic review`)
    if (value.sessionID !== contract.sessionID) throw new Error(`Semantic review session does not match its contract`)
    const createdAt = await born(contract, value.subject)
    const audit = inspect(protocol, value.reviews)
    const now = Date.now()
    for (const review of audit.reviews) {
      if (review.reviewedAt < createdAt || review.reviewedAt > now) {
        throw new Error(`Semantic review timestamp is outside the bound subject interval`)
      }
    }
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "semantic-audit-receipt-v1" as const,
      protocolSHA256: digest(protocol),
      sourceSessionID: contract.sessionID,
      subject: value.subject,
      reviewer: protocol.reviewer,
      scope: protocol.scope,
      reviews: audit.reviews,
      status: audit.status,
      failures: audit.failures,
      evidence: evidence(audit.reviews),
      reviewedAt: Math.max(...audit.reviews.map((item) => item.reviewedAt)),
    }
    const stored = { ...stable, recordedAt: now }
    const receipt = Receipt.parse({ ...stored, receiptID: digest(stored) })
    await JsonStore.update(file(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Semantic audit receipt is immutable once recorded`)
    })
    const saved = await read(receipt.receiptID)
    if (!saved) throw new Error(`Semantic audit receipt was not durable after recording`)
    return saved
  }

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
    evaluatedAt: number
    recordedAt: number
    requirePassed: boolean
  }) {
    const receipt = await read(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt semantic audit receipt ${input.receiptID}`)
    const protocol = input.contract.semanticAudit
    if (!protocol) throw new Error(`Evaluation cites a semantic receipt without a bound semantic audit protocol`)
    if (receipt.protocolSHA256 !== digest(protocol)) {
      throw new Error(`Semantic audit receipt does not match the bound review protocol`)
    }
    if (JSON.stringify(receipt.reviewer) !== JSON.stringify(protocol.reviewer)) {
      throw new Error(`Semantic audit receipt uses a different review authority`)
    }
    if (JSON.stringify(receipt.scope) !== JSON.stringify(protocol.scope)) {
      throw new Error(`Semantic audit receipt changed the frozen problem scope`)
    }
    if (receipt.sourceSessionID !== input.contract.sessionID) {
      throw new Error(`Semantic audit receipt belongs to a different harness session`)
    }
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Semantic audit receipt belongs to a different evaluation subject`)
    }
    const createdAt = await born(input.contract, input.subject)
    const audit = inspect(protocol, receipt.reviews)
    if (
      receipt.status !== audit.status ||
      JSON.stringify(receipt.failures) !== JSON.stringify(audit.failures) ||
      JSON.stringify(receipt.evidence) !== JSON.stringify(evidence(audit.reviews)) ||
      receipt.reviewedAt !== Math.max(...audit.reviews.map((item) => item.reviewedAt))
    ) {
      throw new Error(`Semantic audit receipt does not match backend-derived review state`)
    }
    if (
      audit.reviews.some(
        (review) => review.reviewedAt < createdAt || review.reviewedAt > receipt.recordedAt,
      )
    ) {
      throw new Error(`Semantic audit receipt contains a review outside the bound subject interval`)
    }
    if (receipt.reviewedAt > input.evaluatedAt || receipt.recordedAt > input.recordedAt) {
      throw new Error(`Evaluation predates its semantic audit receipt`)
    }
    if (input.requirePassed && receipt.status !== "meaningful") {
      throw new Error(`A passing final evaluation requires a meaningful semantic audit receipt`)
    }
    return receipt
  }
}
