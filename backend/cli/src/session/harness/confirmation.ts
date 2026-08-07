import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessDomain } from "./domain"
import { HarnessEvaluation } from "./evaluation"
import { HarnessMeta } from "./meta"
import { HarnessSearch } from "./search"

export namespace HarnessConfirmation {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      confirmationToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  export const Submit = z
    .object({
      schemaVersion: z.literal(1),
      sessionID: z.string().min(1).max(240),
      confirmationToken: Token,
      candidateSHA256: Hash,
      manifestSHA256: Hash,
      validatorSHA256: Hash,
      environmentSHA256: Hash,
      outcome: z.enum(["completed", "failed", "inconclusive"]),
      score: z.number().finite().optional(),
      metrics: z
        .record(z.string().max(200), z.number().finite())
        .refine((value) => Object.keys(value).length <= 128, "A confirmation may contain at most 128 metrics")
        .default({}),
      checks: z.array(HarnessEvaluation.Check).min(1).max(128),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(128),
      usage: HarnessEvaluation.Usage.optional(),
      outputSHA256: Hash,
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (new Set(value.checks.map((item) => item.id)).size !== value.checks.length) {
        ctx.addIssue({ code: "custom", path: ["checks"], message: "Confirmation check IDs must be unique" })
      }
      if (!value.checks.some((item) => item.blocking)) {
        ctx.addIssue({ code: "custom", path: ["checks"], message: "Confirmation requires a blocking check" })
      }
      if (value.outcome === "completed" && value.score === undefined) {
        ctx.addIssue({ code: "custom", path: ["score"], message: "A completed confirmation requires a score" })
      }
      if (value.outcome !== "completed" && value.score !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["score"],
          message: "An incomplete confirmation cannot publish a partial score",
        })
      }
    })
  export type Submit = z.input<typeof Submit>
  type Submission = z.infer<typeof Submit>
  type Audit = Pick<
    Submission,
    "manifestSHA256" | "validatorSHA256" | "environmentSHA256" | "outcome" | "score" | "metrics" | "checks"
  >

  const Artifact = z
    .object({
      uri: z.string().min(1).max(2_048),
      sha256: Hash,
    })
    .strict()

  const SelectionBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("terminal-verified-best-selection-v1"),
      selectionID: Hash,
      contractSHA256: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1).max(240),
      runID: z.string().min(1).max(240),
      searchRevision: z.number().int().nonnegative(),
      stopReason: HarnessSearch.Stop,
      candidateID: Hash,
      candidateArtifact: Artifact,
      candidateCreatedAt: z.number().int().positive(),
      optimizationResultSHA256: Hash,
      optimizationEvaluationSHA256: Hash,
      selectedAt: z.number().int().positive(),
    })
    .strict()

  export const Selection = SelectionBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.selectionID
    if (digest(stable) === value.selectionID) return
    ctx.addIssue({ code: "custom", path: ["selectionID"], message: "Confirmation selection hash is invalid" })
  })
  export type Selection = z.infer<typeof Selection>

  const ReceiptBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("sealed-confirmation-receipt-v1"),
      receiptID: Hash,
      contractSHA256: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1).max(240),
      runID: z.string().min(1).max(240),
      selection: Selection,
      claim: HarnessContract.ConfirmationClaim,
      outcome: z.enum(["completed", "failed", "inconclusive"]),
      status: HarnessEvaluation.Status,
      score: z.number().finite().optional(),
      metrics: z.record(z.string(), z.number().finite()),
      checks: z.array(HarnessEvaluation.Check).min(1).max(128),
      failures: z.array(z.string().min(1).max(500)).max(256),
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(4_224),
      usage: HarnessEvaluation.Usage.optional(),
      outputSHA256: Hash,
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()

  export const Receipt = ReceiptBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.receiptID
    if (digest(stable) === value.receiptID) return
    ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Sealed confirmation receipt hash is invalid" })
  })
  export type Receipt = z.infer<typeof Receipt>

  const Claim = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      contractSHA256: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1).max(240),
      selectionID: Hash,
    })
    .strict()

  const root = path.join(Global.Path.data, "harness", "confirmations")
  const file = (receiptID: string) => path.join(root, `${receiptID}.json`)
  const claimfile = (sessionID: string) => path.join(root, "sessions", `${digest(sessionID)}.json`)

  async function claim(sessionID: string) {
    const data = await JsonStore.read(claimfile(sessionID))
    if (!Object.keys(data).length) return null
    return Claim.parse(data)
  }

  function audit(protocol: HarnessContract.Confirmation, input: Audit) {
    if (input.manifestSHA256 !== protocol.claim.manifestSHA256) {
      throw new Error(`Claim evaluation changed the frozen claim manifest`)
    }
    if (input.validatorSHA256 !== protocol.claim.validatorSHA256) {
      throw new Error(`Claim evaluation changed the frozen validator`)
    }
    if (input.environmentSHA256 !== protocol.claim.environmentSHA256) {
      throw new Error(`Claim evaluation changed the frozen environment`)
    }
    const metric = input.metrics[protocol.claim.metric]
    if (input.outcome === "completed" && metric !== input.score) {
      throw new Error(`Claim score does not match the bound ${protocol.claim.metric} metric`)
    }
    if (input.outcome !== "completed" && metric !== undefined) {
      throw new Error(`An incomplete confirmation cannot publish a partial claim metric`)
    }
    const blocked = input.checks.filter((item) => item.blocking && item.status !== "passed")
    const target =
      input.score !== undefined &&
      (protocol.claim.direction === "maximize"
        ? input.score >= protocol.claim.target
        : input.score <= protocol.claim.target)
    const status =
      input.outcome === "failed" || blocked.some((item) => item.status === "failed")
        ? ("failed" as const)
        : input.outcome === "inconclusive" || blocked.some((item) => item.status === "inconclusive")
          ? ("inconclusive" as const)
          : target
            ? ("passed" as const)
            : ("failed" as const)
    const failures = [
      ...(input.outcome === "failed" ? ["claim evaluator failed before producing a complete result"] : []),
      ...(input.outcome === "inconclusive" ? ["claim evaluator returned an inconclusive result"] : []),
      ...blocked.map((item) => `blocking-check:${item.id}:${item.status}`),
      ...(input.outcome === "completed" && !target
        ? [`claim score ${input.score} does not satisfy ${protocol.claim.direction} target ${protocol.claim.target}`]
        : []),
    ]
    return { status, failures }
  }

  export async function select(contract: HarnessContract.Info) {
    const protocol = contract.confirmation
    if (!protocol) throw new Error(`Harness contract does not require sealed confirmation`)
    await HarnessMeta.assertPromotable(contract)
    const state = await HarnessSearch.read(contract.sessionID)
    if (state.runID !== contract.runID) throw new Error(`Search state does not match the bound harness run`)
    if (state.status !== "completed" || !state.stopReason || !state.bestID) {
      throw new Error(`Sealed confirmation requires a terminal search with one verified winner`)
    }
    if (Object.values(state.reservations).some((item) => item.status === "open")) {
      throw new Error(`Sealed confirmation cannot select while candidate reservations remain open`)
    }
    const candidate = state.candidates[state.bestID]
    if (!candidate || candidate.result?.source !== "verified" || candidate.result.status !== "passed") {
      throw new Error(`The server-selected confirmation subject is not a verified passing candidate`)
    }
    const evaluation = (await HarnessEvaluation.list(contract.sessionID)).findLast(
      (item) =>
        item.subject?.type === "candidate" && item.subject.id === candidate.id && HarnessEvaluation.verified(item),
    )
    if (!evaluation) throw new Error(`The terminal winner has no durable verified optimization evaluation`)
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "terminal-verified-best-selection-v1" as const,
      contractSHA256: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
      sourceSessionID: contract.sessionID,
      runID: contract.runID,
      searchRevision: state.revision,
      stopReason: state.stopReason,
      candidateID: candidate.id,
      candidateArtifact: candidate.artifact,
      candidateCreatedAt: candidate.createdAt,
      optimizationResultSHA256: digest(candidate.result),
      optimizationEvaluationSHA256: HarnessEvaluation.fingerprint(evaluation),
      selectedAt: state.updatedAt,
    }
    return Selection.parse({ ...stable, selectionID: digest(stable) })
  }

  function comparable(receipt: Receipt, stable: Omit<Receipt, "receiptID" | "recordedAt">) {
    const current = structuredClone(receipt) as Record<string, unknown>
    delete current.receiptID
    delete current.recordedAt
    return JSON.stringify(current) === JSON.stringify(stable)
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const protocol = contract.confirmation
    if (!protocol) throw new Error(`Harness contract does not require sealed confirmation`)
    if (value.sessionID !== contract.sessionID) throw new Error(`Confirmation session does not match its contract`)
    const selection = await select(contract)
    if (value.candidateSHA256 !== selection.candidateArtifact.sha256) {
      throw new Error(`Claim evaluator did not evaluate the server-selected candidate artifact`)
    }
    const now = Date.now()
    if (value.evaluatedAt < selection.selectedAt || value.evaluatedAt > now) {
      throw new Error(`Claim evaluation timestamp is outside the terminal selection interval`)
    }
    const result = audit(protocol, value)
    if (result.status === "passed") HarnessDomain.assert(contract.packs ?? [], value.checks)
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "sealed-confirmation-receipt-v1" as const,
      contractSHA256: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
      sourceSessionID: contract.sessionID,
      runID: contract.runID,
      selection,
      claim: protocol.claim,
      outcome: value.outcome,
      status: result.status,
      score: value.score,
      metrics: value.metrics,
      checks: value.checks,
      failures: result.failures,
      evidence: [...new Set([...value.evidence, ...value.checks.flatMap((item) => item.evidence)])].toSorted(),
      usage: value.usage,
      outputSHA256: value.outputSHA256,
      evaluatedAt: value.evaluatedAt,
    }
    const active = await claim(contract.sessionID)
    if (active) {
      const receipt = await read(active.receiptID)
      if (!receipt) throw new Error(`The session's frozen confirmation receipt is corrupt`)
      if (comparable(receipt, stable)) return receipt
      throw new Error(`The session already has a frozen confirmation receipt; holdout retries are forbidden`)
    }
    const body = { ...stable, recordedAt: now }
    const receipt = Receipt.parse({ ...body, receiptID: digest(body) })
    await JsonStore.update(file(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Sealed confirmation receipt is immutable once recorded`)
    })
    const saved = await read(receipt.receiptID)
    if (!saved) throw new Error(`Sealed confirmation receipt was not durable after recording`)
    const statement = Claim.parse({
      schemaVersion: 1,
      receiptID: saved.receiptID,
      contractSHA256: saved.contractSHA256,
      protocolSHA256: saved.protocolSHA256,
      sourceSessionID: saved.sourceSessionID,
      selectionID: saved.selection.selectionID,
    })
    await JsonStore.update(claimfile(contract.sessionID), async (data) => {
      if (!Object.keys(data).length) return statement
      const current = Claim.parse(data)
      if (current.receiptID === statement.receiptID) return current
      const winner = await read(current.receiptID)
      if (winner && comparable(winner, stable)) return current
      throw new Error(`The session already has a frozen confirmation receipt; holdout retries are forbidden`)
    })
    const frozen = await claim(contract.sessionID)
    if (!frozen) throw new Error(`Sealed confirmation receipt was not durably frozen for its session`)
    const winner = await read(frozen.receiptID)
    if (winner && comparable(winner, stable)) return winner
    throw new Error(`The session already has a different frozen confirmation receipt`)
  }

  export async function read(receiptID: string) {
    const id = Hash.parse(receiptID)
    const data = await JsonStore.read(file(id))
    const parsed = Receipt.safeParse(data)
    return parsed.success && parsed.data.receiptID === id ? parsed.data : null
  }

  export function binds(contract: HarnessContract.Info, input: Receipt) {
    const receipt = Receipt.parse(input)
    const protocol = contract.confirmation
    if (!protocol) throw new Error(`Receipt cites a confirmation protocol that is not bound`)
    if (
      receipt.contractSHA256 !== HarnessContract.fingerprint(contract) ||
      receipt.protocolSHA256 !== digest(protocol) ||
      receipt.sourceSessionID !== contract.sessionID ||
      receipt.runID !== contract.runID ||
      JSON.stringify(receipt.claim) !== JSON.stringify(protocol.claim)
    ) {
      throw new Error(`Sealed confirmation receipt does not match the bound contract`)
    }
    return receipt
  }

  export async function assert(contract: HarnessContract.Info, receiptID: string) {
    const stored = await read(receiptID)
    if (!stored) throw new Error(`Unknown or corrupt sealed confirmation receipt ${receiptID}`)
    const receipt = binds(contract, stored)
    const protocol = contract.confirmation!
    const active = await claim(contract.sessionID)
    if (active?.receiptID !== receipt.receiptID) {
      throw new Error(`Receipt is not the session's canonical sealed confirmation`)
    }
    const selection = await select(contract)
    if (JSON.stringify(selection) !== JSON.stringify(receipt.selection)) {
      throw new Error(`Sealed confirmation receipt changed the server-selected terminal winner`)
    }
    const result = audit(protocol, {
      manifestSHA256: receipt.claim.manifestSHA256,
      validatorSHA256: receipt.claim.validatorSHA256,
      environmentSHA256: receipt.claim.environmentSHA256,
      outcome: receipt.outcome,
      score: receipt.score,
      metrics: receipt.metrics,
      checks: receipt.checks,
    })
    if (receipt.status !== result.status || JSON.stringify(receipt.failures) !== JSON.stringify(result.failures)) {
      throw new Error(`Sealed confirmation receipt does not match the backend-derived verdict`)
    }
    if (receipt.status === "passed") HarnessDomain.assert(contract.packs ?? [], receipt.checks)
    if (receipt.evaluatedAt < receipt.selection.selectedAt || receipt.evaluatedAt > receipt.recordedAt) {
      throw new Error(`Sealed confirmation receipt predates its terminal candidate selection`)
    }
    return receipt
  }

  export async function current(contract: HarnessContract.Info) {
    if (!contract.confirmation) return null
    const active = await claim(contract.sessionID)
    return active ? assert(contract, active.receiptID) : null
  }

  export function prompt(contract: HarnessContract.Info) {
    const protocol = contract.confirmation
    if (!protocol) return ""
    return [
      "<sealed-confirmation-policy>",
      "Optimization evaluator results are provisional search signals, not final benchmark evidence.",
      `Search may use only the committed ${protocol.optimization.split} optimization split. The distinct ${protocol.claim.split} claim split is reserved for one post-search confirmation.`,
      "The backend selects exactly one verified winner only after search is terminal. The agent may not nominate, swap, or retry a claim candidate.",
      "Do not access the claim manifest, claim evaluator capability, claim outputs, or partial claim metrics during search.",
      "Claim results never feed candidate ranking, adaptive control, hindsight memory, or learned-skill generation. Reports remain provisional until the immutable confirmation receipt exists.",
      "</sealed-confirmation-policy>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    return contract ? prompt(contract) : ""
  }
}
