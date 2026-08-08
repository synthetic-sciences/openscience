import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"
import { HarnessEvolution } from "./evolution"
import { HarnessSearch } from "./search"

export namespace HarnessMeta {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")
  const SourcePath = z
    .string()
    .min(1)
    .max(1_000)
    .refine(
      (value) =>
        value === "." ||
        (!value.startsWith("/") &&
          !value.endsWith("/") &&
          !value.includes("\\") &&
          !value.split("/").some((part) => !part || part === "." || part === "..")),
      "Meta-harness paths must be normalized relative POSIX paths",
    )

  export const Access = z
    .object({
      sessionID: z.string().min(1).max(240),
      metaToken: Token,
    })
    .strict()
  export type Access = z.infer<typeof Access>

  const Trace = z
    .object({
      uri: z.string().min(1).max(2_048),
      sha256: Hash,
      schemaSHA256: Hash,
      complete: z.literal(true),
      hiddenContent: z.literal("excluded"),
      evaluatorContent: z.literal("excluded"),
    })
    .strict()

  const ArchiveEntry = z
    .object({
      candidateID: Hash,
      artifactSHA256: Hash,
      sourceSHA256: Hash,
      state: z.enum(["evaluated", "unevaluated"]),
      scoresSHA256: Hash.optional(),
      resultSHA256: Hash.optional(),
      evaluationSHA256: Hash.optional(),
      trace: Trace.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const evidence = [value.scoresSHA256, value.resultSHA256, value.evaluationSHA256, value.trace]
      if (value.state === "evaluated" && evidence.some((item) => item === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["state"],
          message: "Evaluated archive entries require scores and trace evidence",
        })
      }
      if (value.state === "unevaluated" && evidence.some((item) => item !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["state"],
          message: "Unevaluated archive entries cannot claim result evidence",
        })
      }
    })

  const Archive = z
    .object({
      uri: z.string().min(1).max(2_048),
      sha256: Hash,
      schemaSHA256: Hash,
      indexSHA256: Hash,
      contents: z.literal("full-source-scores-traces"),
      query: z.literal("filesystem"),
      complete: z.literal(true),
      hiddenContent: z.literal("excluded"),
      evaluatorContent: z.literal("excluded"),
      entries: z
        .array(ArchiveEntry)
        .min(1)
        .max(10_000)
        .refine(
          (items) => new Set(items.map((item) => item.candidateID)).size === items.length,
          "Archive candidates must be unique",
        )
        .refine(
          (items) => items.every((item, index) => !index || items[index - 1]!.candidateID < item.candidateID),
          "Archive candidates must be sorted",
        ),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (digest(value.entries) !== value.indexSHA256) {
        ctx.addIssue({ code: "custom", path: ["indexSHA256"], message: "Archive index hash is invalid" })
      }
      const stable = structuredClone(value) as Record<string, unknown>
      delete stable.sha256
      if (digest(stable) === value.sha256) return
      ctx.addIssue({ code: "custom", path: ["sha256"], message: "Archive content hash is invalid" })
    })

  const Change = z
    .object({
      action: z.enum(["create", "update", "delete", "rollback"]),
      component: HarnessContract.MetaComponent,
      path: SourcePath,
      beforeSHA256: Hash.optional(),
      afterSHA256: Hash.optional(),
      reason: z.string().min(1).max(4_000),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === "create" && (value.beforeSHA256 || !value.afterSHA256)) {
        ctx.addIssue({ code: "custom", path: ["action"], message: "Create changes require only an after hash" })
      }
      if (value.action === "delete" && (!value.beforeSHA256 || value.afterSHA256)) {
        ctx.addIssue({ code: "custom", path: ["action"], message: "Delete changes require only a before hash" })
      }
      if (["update", "rollback"].includes(value.action) && (!value.beforeSHA256 || !value.afterSHA256)) {
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: "Update and rollback changes require before and after hashes",
        })
      }
      if (value.beforeSHA256 && value.afterSHA256 && value.beforeSHA256 === value.afterSHA256) {
        ctx.addIssue({ code: "custom", path: ["afterSHA256"], message: "A refinement change must alter content" })
      }
    })

  const Citation = z
    .object({
      candidateID: Hash,
      traceSHA256: Hash,
      messageIndex: z.number().int().nonnegative(),
      excerptSHA256: Hash,
    })
    .strict()

  const Prediction = z
    .object({
      modelID: z.string().min(1).max(240),
      taskID: z.string().min(1).max(200),
      expected: z.enum(["fail_to_pass", "remain_pass"]),
    })
    .strict()

  const Refinement = z
    .object({
      revision: z.number().int().positive(),
      scope: z.literal("session"),
      parentSnapshotSHA256: Hash,
      snapshotSHA256: Hash,
      trigger: z.string().min(1).max(4_000),
      diagnosis: z
        .object({
          kind: z.enum(["implementation", "fundamental", "inconclusive"]),
          rationale: z.string().min(1).max(8_000),
        })
        .strict(),
      rootCause: z.string().min(1).max(8_000),
      expectedOutcome: z.string().min(1).max(8_000),
      changes: z
        .array(Change)
        .min(1)
        .max(128)
        .refine(
          (items) => new Set(items.map((item) => item.path)).size === items.length,
          "Refinement paths must be unique",
        )
        .refine(
          (items) => items.every((item, index) => !index || items[index - 1]!.path < item.path),
          "Refinement paths must be sorted",
        ),
      evidence: z
        .array(Citation)
        .min(1)
        .max(256)
        .refine(
          (items) =>
            new Set(
              items.map(
                (item) => `${item.candidateID}\0${item.traceSHA256}\0${item.messageIndex}\0${item.excerptSHA256}`,
              ),
            ).size === items.length,
          "Refinement citations must be unique",
        )
        .refine(
          (items) =>
            items.every(
              (item, index) =>
                !index ||
                `${items[index - 1]!.candidateID}\0${items[index - 1]!.traceSHA256}\0${items[index - 1]!.messageIndex}\0${items[index - 1]!.excerptSHA256}` <
                  `${item.candidateID}\0${item.traceSHA256}\0${item.messageIndex}\0${item.excerptSHA256}`,
            ),
          "Refinement citations must be sorted",
        ),
      predictions: z
        .array(Prediction)
        .min(1)
        .max(256)
        .refine(
          (items) => new Set(items.map((item) => `${item.modelID}\0${item.taskID}`)).size === items.length,
          "Refinement predictions must be unique",
        )
        .refine(
          (items) =>
            items.every(
              (item, index) =>
                !index ||
                `${items[index - 1]!.modelID}\0${items[index - 1]!.taskID}` < `${item.modelID}\0${item.taskID}`,
            ),
          "Refinement predictions must be sorted",
        ),
    })
    .strict()

  export const PhaseID = z.enum(["loaded", "midpoint", "pre_final", "final_validation"])
  export type PhaseID = z.infer<typeof PhaseID>

  const Counts = z
    .object({
      followed: z.number().int().nonnegative(),
      violatedCommission: z.number().int().nonnegative(),
      violatedOmission: z.number().int().nonnegative(),
      requiredUnobserved: z.number().int().nonnegative(),
      notApplicable: z.number().int().nonnegative(),
      insufficientEvidence: z.number().int().nonnegative(),
    })
    .strict()

  const Phase = Counts.extend({ phase: PhaseID }).strict()

  const CellBase = z
    .object({
      split: z.enum(["search", "held_out"]),
      modelID: z.string().min(1).max(240),
      modelCommitment: Hash,
      taskID: z.string().min(1).max(200),
      taskCommitment: Hash,
      outcome: z.enum(["completed", "failed", "inconclusive"]),
      score: z.number().finite().optional(),
      passed: z.boolean().optional(),
      contextTokens: z.number().int().nonnegative(),
      outputSHA256: Hash,
      trace: Trace,
      evidence: z.array(z.string().min(1).max(1_000)).min(1).max(64),
    })
    .strict()

  const BaselineCell = CellBase.extend({ role: z.literal("baseline") })
    .strict()
    .superRefine((value, ctx) => validateOutcome(value, ctx))

  const CandidateCell = CellBase.extend({
    role: z.literal("candidate"),
    loaded: z.boolean(),
    phases: z
      .array(Phase)
      .max(PhaseID.options.length)
      .refine(
        (items) => new Set(items.map((item) => item.phase)).size === items.length,
        "Adherence phases must be unique",
      )
      .refine(
        (items) =>
          items.every(
            (item, index) =>
              !index || PhaseID.options.indexOf(items[index - 1]!.phase) < PhaseID.options.indexOf(item.phase),
          ),
        "Adherence phases must use canonical order",
      ),
  })
    .strict()
    .superRefine((value, ctx) => validateOutcome(value, ctx))

  function validateOutcome(value: z.infer<typeof CellBase>, ctx: z.RefinementCtx) {
    if (value.outcome === "completed" && (value.score === undefined || value.passed === undefined)) {
      ctx.addIssue({ code: "custom", path: ["outcome"], message: "Completed cells require a score and pass verdict" })
    }
    if (value.outcome !== "completed" && (value.score !== undefined || value.passed !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["outcome"], message: "Incomplete cells cannot publish partial scores" })
    }
  }

  export const Cell = z.discriminatedUnion("role", [BaselineCell, CandidateCell])
  export type Cell = z.infer<typeof Cell>

  export const Submit = z
    .object({
      schemaVersion: z.literal(1),
      sessionID: z.string().min(1).max(240),
      metaToken: Token,
      selectionID: Hash,
      candidateArtifactSHA256: Hash,
      candidateManifestSHA256: Hash,
      protectedManifestSHA256: Hash,
      validatorSHA256: Hash,
      archive: Archive,
      refinements: z.array(Refinement).min(1).max(128),
      cells: z
        .array(Cell)
        .min(4)
        .max(65_536)
        .refine(
          (items) =>
            new Set(items.map((item) => `${item.split}\0${item.modelID}\0${item.taskID}\0${item.role}`)).size ===
            items.length,
          "Qualification cells must be unique",
        )
        .refine(
          (items) =>
            items.every(
              (item, index) =>
                !index ||
                `${items[index - 1]!.split}\0${items[index - 1]!.modelID}\0${items[index - 1]!.taskID}\0${items[index - 1]!.role}` <
                  `${item.split}\0${item.modelID}\0${item.taskID}\0${item.role}`,
            ),
          "Qualification cells must be sorted",
        ),
      evaluatedAt: z.number().int().positive(),
    })
    .strict()
  export type Submit = z.input<typeof Submit>

  const SelectionBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("meta-harness-selection-v1"),
      selectionID: Hash,
      contractSHA256: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1).max(240),
      runID: z.string().min(1).max(240),
      searchRevision: z.number().int().nonnegative(),
      stopReason: HarnessSearch.Stop,
      candidateID: Hash,
      candidateArtifact: z.object({ uri: z.string().min(1).max(2_048), sha256: Hash }).strict(),
      optimizationResultSHA256: Hash,
      optimizationEvaluationSHA256: Hash,
      selectedAt: z.number().int().positive(),
    })
    .strict()

  export const Selection = SelectionBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.selectionID
    if (digest(stable) === value.selectionID) return
    ctx.addIssue({ code: "custom", path: ["selectionID"], message: "Meta-harness selection hash is invalid" })
  })
  export type Selection = z.infer<typeof Selection>

  export const Diagnostics = z
    .object({
      updaterGain: z.number().finite().optional(),
      beneficiaryGain: z.number().finite().optional(),
      worstHeldoutModelGain: z.number().finite().optional(),
      activationRate: z.number().finite().min(0).max(1),
      requiredAdherence: z.number().finite().min(0).max(1).optional(),
      finalAdherence: z.number().finite().min(0).max(1).optional(),
      maxPhaseDrift: z.number().finite().min(0).max(1).optional(),
      predictionPrecision: z.number().finite().min(0).max(1),
      riskRegressions: z.number().int().nonnegative(),
      maxContextTokens: z.number().int().nonnegative(),
      meanContextIncrease: z.number().finite(),
      loadedBenefit: z.number().finite().optional(),
      searchPairs: z.number().int().positive(),
      heldoutPairs: z.number().int().positive(),
    })
    .strict()
  export type Diagnostics = z.infer<typeof Diagnostics>

  const ReceiptBase = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("meta-harness-receipt-v1"),
      receiptID: Hash,
      contractSHA256: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1).max(240),
      runID: z.string().min(1).max(240),
      selection: Selection,
      candidateManifestSHA256: Hash,
      protectedManifestSHA256: Hash,
      validatorSHA256: Hash,
      archive: Archive,
      refinements: z.array(Refinement).min(1).max(128),
      cells: z.array(Cell).min(4).max(65_536),
      diagnostics: Diagnostics,
      status: HarnessEvaluation.Status,
      failures: z.array(z.string().min(1).max(1_000)).max(1_024),
      evaluatedAt: z.number().int().positive(),
      recordedAt: z.number().int().positive(),
    })
    .strict()

  export const Receipt = ReceiptBase.superRefine((value, ctx) => {
    const stable = structuredClone(value) as Record<string, unknown>
    delete stable.receiptID
    if (digest(stable) === value.receiptID) return
    ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Meta-harness receipt hash is invalid" })
  })
  export type Receipt = z.infer<typeof Receipt>

  const Claim = z
    .object({
      schemaVersion: z.literal(1),
      receiptID: Hash,
      contractSHA256: Hash,
      protocolSHA256: Hash,
      sourceSessionID: z.string().min(1),
      selectionID: Hash,
    })
    .strict()

  const root = path.join(Global.Path.data, "harness", "meta")
  const file = (receiptID: string) => path.join(root, `${receiptID}.json`)
  const claimfile = (sessionID: string) => path.join(root, "sessions", `${digest(sessionID)}.json`)
  const covers = (root: string, target: string) => root === "." || target === root || target.startsWith(`${root}/`)
  const key = (cell: Cell) => `${cell.split}\0${cell.modelID}\0${cell.taskID}\0${cell.role}`
  const pairKey = (cell: Cell) => `${cell.split}\0${cell.modelID}\0${cell.taskID}`
  const rate = (phase: z.infer<typeof Phase>) => {
    const total = phase.followed + phase.violatedCommission + phase.violatedOmission + phase.requiredUnobserved
    return total ? phase.followed / total : undefined
  }

  async function claim(sessionID: string) {
    const data = await JsonStore.read(claimfile(sessionID))
    if (!Object.keys(data).length) return null
    return Claim.parse(data)
  }

  export async function select(contract: HarnessContract.Info) {
    const protocol = contract.metaHarness
    if (!protocol) throw new Error(`Harness contract does not require meta-harness qualification`)
    const state = await HarnessSearch.read(contract.sessionID)
    if (state.runID !== contract.runID) throw new Error(`Search state does not match the bound harness run`)
    if (state.status !== "completed" || !state.stopReason || !state.bestID) {
      throw new Error(`Meta-harness qualification requires a terminal search with one verified winner`)
    }
    if (Object.values(state.reservations).some((item) => item.status === "open")) {
      throw new Error(`Meta-harness qualification cannot start while candidate reservations remain open`)
    }
    const candidate = state.candidates[state.bestID]
    if (!candidate || candidate.result?.source !== "verified" || candidate.result.status !== "passed") {
      throw new Error(`The server-selected meta-harness subject is not a verified passing candidate`)
    }
    const evaluation = (await HarnessEvaluation.list(contract.sessionID)).findLast(
      (item) =>
        item.subject?.type === "candidate" && item.subject.id === candidate.id && HarnessEvaluation.verified(item),
    )
    if (!evaluation) throw new Error(`The terminal winner has no durable verified optimization evaluation`)
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "meta-harness-selection-v1" as const,
      contractSHA256: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
      sourceSessionID: contract.sessionID,
      runID: contract.runID,
      searchRevision: state.revision,
      stopReason: state.stopReason,
      candidateID: candidate.id,
      candidateArtifact: candidate.artifact,
      optimizationResultSHA256: digest(candidate.result),
      optimizationEvaluationSHA256: HarnessEvaluation.fingerprint(evaluation),
      selectedAt: state.updatedAt,
    }
    return Selection.parse({ ...stable, selectionID: digest(stable) })
  }

  function expected(protocol: HarnessContract.MetaHarness) {
    return [
      ...protocol.search.models.flatMap((modelID) =>
        protocol.search.tasks.flatMap((task) =>
          (["baseline", "candidate"] as const).map((role) => `search\0${modelID.id}\0${task.id}\0${role}`),
        ),
      ),
      ...protocol.heldout.models.flatMap((modelID) =>
        protocol.heldout.tasks.flatMap((task) =>
          (["baseline", "candidate"] as const).map((role) => `held_out\0${modelID.id}\0${task.id}\0${role}`),
        ),
      ),
    ].toSorted()
  }

  function task(protocol: HarnessContract.MetaHarness, split: Cell["split"], id: string) {
    return (split === "search" ? protocol.search.tasks : protocol.heldout.tasks).find((item) => item.id === id)!
  }

  function model(protocol: HarnessContract.MetaHarness, split: Cell["split"], id: string) {
    return (split === "search" ? protocol.search.models : protocol.heldout.models).find((item) => item.id === id)!
  }

  async function validateArchive(
    protocol: HarnessContract.MetaHarness,
    archive: z.infer<typeof Archive>,
    state: HarnessSearch.State,
    evaluations: HarnessEvaluation.Info[],
  ) {
    if (
      archive.schemaSHA256 !== protocol.archiveSchemaSHA256 ||
      archive.contents !== protocol.archive.contents ||
      archive.query !== protocol.archive.query ||
      archive.hiddenContent !== protocol.archive.hiddenContent ||
      archive.evaluatorContent !== protocol.archive.evaluatorContent
    ) {
      throw new Error(`Full-history archive does not match the frozen meta-harness protocol`)
    }
    const candidates = Object.values(state.candidates).toSorted((left, right) => left.id.localeCompare(right.id))
    if (
      JSON.stringify(archive.entries.map((item) => item.candidateID)) !==
      JSON.stringify(candidates.map((item) => item.id))
    ) {
      throw new Error(`Full-history archive must contain every search candidate exactly once`)
    }
    for (const candidate of candidates) {
      const entry = archive.entries.find((item) => item.candidateID === candidate.id)!
      if (entry.artifactSHA256 !== candidate.artifact.sha256) {
        throw new Error(`Archive candidate ${candidate.id} changed its artifact`)
      }
      if (!candidate.result && entry.state !== "unevaluated") {
        throw new Error(`Archive candidate ${candidate.id} fabricates an evaluation`)
      }
      if (!candidate.result) continue
      if (entry.state !== "evaluated" || entry.resultSHA256 !== digest(candidate.result)) {
        throw new Error(`Archive candidate ${candidate.id} changed its recorded result`)
      }
      if (entry.scoresSHA256 !== digest(candidate.result.metrics)) {
        throw new Error(`Archive candidate ${candidate.id} changed its recorded scores`)
      }
      if (!candidate.result.evolution) throw new Error(`Archive candidate ${candidate.id} has no exact source lineage`)
      const evolution = await HarnessEvolution.read(state.sessionID, candidate.result.evolution.receiptID)
      if (!evolution || entry.sourceSHA256 !== evolution.snapshot.artifact.sha256) {
        throw new Error(`Archive candidate ${candidate.id} changed its exact source snapshot`)
      }
      if (entry.artifactSHA256 !== entry.sourceSHA256) {
        throw new Error(`Meta-harness candidates must use the exact source snapshot as their search artifact`)
      }
      const evaluation =
        evaluations.findLast(
          (item) =>
            item.subject?.type === "candidate" &&
            item.subject.id === candidate.id &&
            item.fidelity?.stage === candidate.result?.fidelity?.stage,
        ) ?? evaluations.findLast((item) => item.subject?.type === "candidate" && item.subject.id === candidate.id)
      if (!evaluation || entry.evaluationSHA256 !== HarnessEvaluation.fingerprint(evaluation)) {
        throw new Error(`Archive candidate ${candidate.id} changed its evaluation`)
      }
      if (entry.trace?.schemaSHA256 !== protocol.traceSchemaSHA256) {
        throw new Error(`Archive candidate ${candidate.id} changed the trace schema`)
      }
    }
  }

  async function validateManifests(
    protocol: HarnessContract.MetaHarness,
    state: HarnessSearch.State,
    candidateID: string,
    candidateManifestSHA256: string,
    protectedManifestSHA256: string,
  ) {
    const candidate = state.candidates[candidateID]
    if (!candidate?.result?.evolution) throw new Error(`Selected meta-harness candidate has no exact source lineage`)
    const receipt = await HarnessEvolution.read(state.sessionID, candidate.result.evolution.receiptID)
    if (!receipt) throw new Error(`Selected meta-harness source lineage is unavailable`)
    const files = receipt.snapshot.files.map((file) => ({ path: file.path, sha256: file.sha256 }))
    if (digest(files) !== candidateManifestSHA256) {
      throw new Error(`Meta-harness candidate manifest does not match its exact source snapshot`)
    }
    const protectedFiles = files.filter((file) => protocol.protected.roots.some((root) => covers(root, file.path)))
    if (
      digest(protectedFiles) !== protocol.protected.manifestSHA256 ||
      protectedManifestSHA256 !== protocol.protected.manifestSHA256
    ) {
      throw new Error(`Meta-harness candidate changed the protected source manifest`)
    }
  }

  function validateRefinements(
    protocol: HarnessContract.MetaHarness,
    refinements: z.infer<typeof Refinement>[],
    archive: z.infer<typeof Archive>,
    artifactSHA256: string,
  ) {
    const searchModels = new Set(protocol.search.models.map((item) => item.id))
    const searchTasks = new Set(protocol.search.tasks.map((item) => item.id))
    const entries = new Map(archive.entries.map((item) => [item.candidateID, item]))
    const predictions = new Set<string>()
    for (const [index, refinement] of refinements.entries()) {
      if (refinement.revision !== index + 1) throw new Error(`Refinement revisions must be contiguous from one`)
      const parent = index ? refinements[index - 1]!.snapshotSHA256 : protocol.baseline.artifactSHA256
      if (refinement.parentSnapshotSHA256 !== parent)
        throw new Error(`Refinement snapshot lineage is stale or discontinuous`)
      for (const change of refinement.changes) {
        const roots = protocol.mutable.filter((item) => covers(item.root, change.path))
        if (roots.length !== 1 || roots[0]!.component !== change.component) {
          throw new Error(`Refinement path ${change.path} is outside its declared mutable component`)
        }
        if (protocol.protected.roots.some((root) => covers(root, change.path))) {
          throw new Error(`Refinement attempted to modify protected path ${change.path}`)
        }
      }
      for (const citation of refinement.evidence) {
        const entry = entries.get(citation.candidateID)
        if (entry?.state !== "evaluated" || entry.trace?.sha256 !== citation.traceSHA256) {
          throw new Error(`Refinement evidence is not bound to an archived search trace`)
        }
      }
      if (refinement.predictions.some((item) => !searchModels.has(item.modelID) || !searchTasks.has(item.taskID))) {
        throw new Error(`Refinement predictions may cite only frozen search cells`)
      }
      for (const prediction of refinement.predictions) {
        const id = `${prediction.modelID}\0${prediction.taskID}`
        if (predictions.has(id)) throw new Error(`Refinement predictions must be unique across the full lineage`)
        predictions.add(id)
      }
    }
    if (refinements.at(-1)?.snapshotSHA256 !== artifactSHA256) {
      throw new Error(`Final refinement snapshot does not match the selected candidate artifact`)
    }
  }

  function diagnose(
    protocol: HarnessContract.MetaHarness,
    direction: "maximize" | "minimize",
    cells: Cell[],
    refinements: z.infer<typeof Refinement>[],
  ) {
    if (JSON.stringify(cells.map(key)) !== JSON.stringify(expected(protocol))) {
      throw new Error(`Qualification matrix must contain every frozen model-task baseline and candidate cell`)
    }
    for (const cell of cells) {
      if (cell.trace.schemaSHA256 !== protocol.traceSchemaSHA256) {
        throw new Error(`Qualification cell changed the frozen trace schema`)
      }
      if (
        cell.modelCommitment !== model(protocol, cell.split, cell.modelID).commitment ||
        cell.taskCommitment !== task(protocol, cell.split, cell.taskID).commitment
      ) {
        throw new Error(`Qualification cell changed a frozen model or task commitment`)
      }
      if (cell.role !== "candidate") continue
      const activation = task(protocol, cell.split, cell.taskID).activationRequired
      if (!activation && cell.phases.length) throw new Error(`Non-activation tasks cannot publish adherence phases`)
      if (
        activation &&
        cell.loaded &&
        cell.outcome === "completed" &&
        JSON.stringify(cell.phases.map((item) => item.phase)) !== JSON.stringify(PhaseID.options)
      ) {
        throw new Error(`Loaded activation tasks require every canonical adherence phase`)
      }
      if (activation && !cell.loaded && cell.phases.length) {
        throw new Error(`A non-loaded harness cannot claim adherence observations`)
      }
    }
    const cellsByPair = new Map<string, { baseline?: Cell; candidate?: Cell }>()
    for (const cell of cells) {
      const pair = cellsByPair.get(pairKey(cell)) ?? {}
      pair[cell.role] = cell
      cellsByPair.set(pairKey(cell), pair)
    }
    const pairs = [...cellsByPair.values()].map((pair) => ({
      baseline: pair.baseline!,
      candidate: pair.candidate!,
    }))
    const completed = pairs.filter(
      (pair) => pair.baseline.outcome === "completed" && pair.candidate.outcome === "completed",
    )
    const adjusted = (pair: (typeof completed)[number]) =>
      direction === "maximize"
        ? pair.candidate.score! - pair.baseline.score!
        : pair.baseline.score! - pair.candidate.score!
    const search = completed.filter((pair) => pair.candidate.split === "search")
    const heldout = completed.filter((pair) => pair.candidate.split === "held_out")
    const mean = (items: number[]) =>
      items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : undefined
    const updaterGain = mean(search.map(adjusted))
    const beneficiaryGain = mean(heldout.map(adjusted))
    const heldoutModels = protocol.heldout.models.map((model) => ({
      modelID: model.id,
      gain: mean(heldout.filter((pair) => pair.candidate.modelID === model.id).map(adjusted)),
    }))
    const worstHeldoutModelGain = heldoutModels.every((item) => item.gain !== undefined)
      ? Math.min(...heldoutModels.map((item) => item.gain!))
      : undefined
    const activationCells = cells.filter(
      (cell): cell is z.infer<typeof CandidateCell> =>
        cell.role === "candidate" && task(protocol, cell.split, cell.taskID).activationRequired,
    )
    const activationRate = activationCells.filter((cell) => cell.loaded).length / activationCells.length
    const phases = activationCells.filter((cell) => cell.loaded).flatMap((cell) => cell.phases)
    const relevant = phases.reduce(
      (sum, phase) =>
        sum + phase.followed + phase.violatedCommission + phase.violatedOmission + phase.requiredUnobserved,
      0,
    )
    const requiredAdherence = relevant ? phases.reduce((sum, phase) => sum + phase.followed, 0) / relevant : undefined
    const finals = phases.filter((phase) => phase.phase === "final_validation")
    const finalRelevant = finals.reduce(
      (sum, phase) =>
        sum + phase.followed + phase.violatedCommission + phase.violatedOmission + phase.requiredUnobserved,
      0,
    )
    const finalAdherence = finalRelevant
      ? finals.reduce((sum, phase) => sum + phase.followed, 0) / finalRelevant
      : undefined
    const drift = activationCells
      .filter((cell) => cell.loaded)
      .map((cell) => {
        const first = cell.phases.find((phase) => phase.phase === "loaded")
        const last = cell.phases.find((phase) => phase.phase === "final_validation")
        if (!first || !last) return undefined
        const start = rate(first)
        const end = rate(last)
        return start === undefined || end === undefined ? undefined : Math.max(0, start - end)
      })
    const maxPhaseDrift = drift.every((item) => item !== undefined)
      ? Math.max(0, ...drift.map((item) => item!))
      : undefined
    const lookup = new Map(pairs.map((pair) => [pairKey(pair.candidate), pair]))
    const predictions = refinements.flatMap((item) => item.predictions)
    const correct = predictions.filter((prediction) => {
      const pair = lookup.get(`search\0${prediction.modelID}\0${prediction.taskID}`)
      if (!pair || pair.baseline.outcome !== "completed" || pair.candidate.outcome !== "completed") return false
      if (prediction.expected === "fail_to_pass")
        return pair.baseline.passed === false && pair.candidate.passed === true
      return pair.baseline.passed === true && pair.candidate.passed === true
    }).length
    const predictionPrecision = correct / predictions.length
    const riskRegressions = completed.filter(
      (pair) => pair.baseline.passed === true && pair.candidate.passed === false,
    ).length
    const candidateCells = cells.filter((cell) => cell.role === "candidate")
    const maxContextTokens = Math.max(0, ...candidateCells.map((cell) => cell.contextTokens))
    const meanContextIncrease =
      mean(pairs.map((pair) => pair.candidate.contextTokens - pair.baseline.contextTokens)) ?? 0
    const loaded = completed.filter((pair) => pair.candidate.role === "candidate" && pair.candidate.loaded)
    const unloaded = completed.filter((pair) => pair.candidate.role === "candidate" && !pair.candidate.loaded)
    const loadedMean = mean(loaded.map(adjusted))
    const unloadedMean = mean(unloaded.map(adjusted))
    const loadedBenefit = loadedMean === undefined || unloadedMean === undefined ? undefined : loadedMean - unloadedMean
    const diagnostics = Diagnostics.parse({
      updaterGain,
      beneficiaryGain,
      worstHeldoutModelGain,
      activationRate,
      requiredAdherence,
      finalAdherence,
      maxPhaseDrift,
      predictionPrecision,
      riskRegressions,
      maxContextTokens,
      meanContextIncrease,
      loadedBenefit,
      searchPairs: protocol.search.models.length * protocol.search.tasks.length,
      heldoutPairs: protocol.heldout.models.length * protocol.heldout.tasks.length,
    })
    const incomplete = [
      ...cells
        .filter((cell) => cell.outcome !== "completed")
        .map((cell) => `cell:${cell.split}:${cell.modelID}:${cell.taskID}:${cell.role}:${cell.outcome}`),
      ...(phases.some((phase) => phase.insufficientEvidence > 0) ? ["adherence:insufficient-evidence"] : []),
      ...(updaterGain === undefined ? ["updater-gain:unavailable"] : []),
      ...(beneficiaryGain === undefined ? ["beneficiary-gain:unavailable"] : []),
      ...(worstHeldoutModelGain === undefined ? ["heldout-model-regression:unavailable"] : []),
      ...(requiredAdherence === undefined ? ["required-adherence:unavailable"] : []),
      ...(finalAdherence === undefined ? ["final-adherence:unavailable"] : []),
      ...(maxPhaseDrift === undefined ? ["phase-drift:unavailable"] : []),
    ]
    const thresholds = [
      ...(updaterGain !== undefined && updaterGain < protocol.thresholds.minSearchGain
        ? [`updater-gain:${updaterGain}`]
        : []),
      ...(beneficiaryGain !== undefined && beneficiaryGain < protocol.thresholds.minHeldoutGain
        ? [`beneficiary-gain:${beneficiaryGain}`]
        : []),
      ...(worstHeldoutModelGain !== undefined && worstHeldoutModelGain < -protocol.thresholds.maxModelRegression
        ? [`heldout-model-regression:${worstHeldoutModelGain}`]
        : []),
      ...(activationRate < protocol.thresholds.minActivationRate ? [`activation-rate:${activationRate}`] : []),
      ...(requiredAdherence !== undefined && requiredAdherence < protocol.thresholds.minRequiredAdherence
        ? [`required-adherence:${requiredAdherence}`]
        : []),
      ...(finalAdherence !== undefined && finalAdherence < protocol.thresholds.minFinalAdherence
        ? [`final-adherence:${finalAdherence}`]
        : []),
      ...(maxPhaseDrift !== undefined && maxPhaseDrift > protocol.thresholds.maxPhaseDrift
        ? [`phase-drift:${maxPhaseDrift}`]
        : []),
      ...(predictionPrecision < protocol.thresholds.minPredictionPrecision
        ? [`prediction-precision:${predictionPrecision}`]
        : []),
      ...(riskRegressions > protocol.thresholds.maxRiskRegressions ? [`risk-regressions:${riskRegressions}`] : []),
      ...(maxContextTokens > protocol.thresholds.maxContextTokens ? [`context-tokens:${maxContextTokens}`] : []),
      ...(meanContextIncrease > protocol.thresholds.maxMeanContextIncrease
        ? [`mean-context-increase:${meanContextIncrease}`]
        : []),
    ]
    const failures = [...incomplete, ...thresholds]
    const uncertain = cells.some((cell) => cell.outcome === "inconclusive") || incomplete.length > 0
    const hard = cells.some((cell) => cell.outcome === "failed") || thresholds.length > 0
    const status = hard ? ("failed" as const) : uncertain ? ("inconclusive" as const) : ("passed" as const)
    return { diagnostics, failures, status }
  }

  function comparable(receipt: Receipt, stable: Omit<Receipt, "receiptID" | "recordedAt">) {
    const current = structuredClone(receipt) as Record<string, unknown>
    delete current.receiptID
    delete current.recordedAt
    return JSON.stringify(current) === JSON.stringify(stable)
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    const protocol = contract.metaHarness
    if (!protocol) throw new Error(`Harness contract does not require meta-harness qualification`)
    if (value.sessionID !== contract.sessionID) throw new Error(`Meta-harness session does not match its contract`)
    const selection = await select(contract)
    if (value.selectionID !== selection.selectionID)
      throw new Error(`Meta-harness submission changed the server selection`)
    if (value.candidateArtifactSHA256 !== selection.candidateArtifact.sha256) {
      throw new Error(`Meta-harness qualifier did not evaluate the server-selected candidate artifact`)
    }
    if (value.candidateManifestSHA256 === protocol.baseline.manifestSHA256) {
      throw new Error(`Meta-harness candidate did not change the frozen baseline manifest`)
    }
    if (value.protectedManifestSHA256 !== protocol.protected.manifestSHA256) {
      throw new Error(`Meta-harness candidate changed the protected manifest`)
    }
    if (value.validatorSHA256 !== protocol.validatorSHA256) {
      throw new Error(`Meta-harness qualification changed the frozen validator`)
    }
    const now = Date.now()
    if (value.evaluatedAt < selection.selectedAt || value.evaluatedAt > now) {
      throw new Error(`Meta-harness qualification timestamp is outside the terminal selection interval`)
    }
    const [state, evaluations] = await Promise.all([
      HarnessSearch.read(contract.sessionID),
      HarnessEvaluation.list(contract.sessionID),
    ])
    await validateArchive(protocol, value.archive, state, evaluations)
    await validateManifests(
      protocol,
      state,
      selection.candidateID,
      value.candidateManifestSHA256,
      value.protectedManifestSHA256,
    )
    validateRefinements(protocol, value.refinements, value.archive, selection.candidateArtifact.sha256)
    const direction = contract.benchmark.direction
    if (direction !== "maximize" && direction !== "minimize") {
      throw new Error(`Meta-harness qualification requires a numeric benchmark direction`)
    }
    const result = diagnose(protocol, direction, value.cells, value.refinements)
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "meta-harness-receipt-v1" as const,
      contractSHA256: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
      sourceSessionID: contract.sessionID,
      runID: contract.runID,
      selection,
      candidateManifestSHA256: value.candidateManifestSHA256,
      protectedManifestSHA256: value.protectedManifestSHA256,
      validatorSHA256: value.validatorSHA256,
      archive: value.archive,
      refinements: value.refinements,
      cells: value.cells,
      diagnostics: result.diagnostics,
      status: result.status,
      failures: result.failures,
      evaluatedAt: value.evaluatedAt,
    }
    const active = await claim(contract.sessionID)
    if (active) {
      const receipt = await read(active.receiptID)
      if (!receipt) throw new Error(`The session's frozen meta-harness receipt is corrupt`)
      if (comparable(receipt, stable)) return receipt
      throw new Error(`The session already has a frozen meta-harness receipt; qualification retries are forbidden`)
    }
    const body = { ...stable, recordedAt: now }
    const receipt = Receipt.parse({ ...body, receiptID: digest(body) })
    await JsonStore.update(file(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Meta-harness receipt is immutable once recorded`)
    })
    const saved = await read(receipt.receiptID)
    if (!saved) throw new Error(`Meta-harness receipt was not durable after recording`)
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
      throw new Error(`The session already has a frozen meta-harness receipt; qualification retries are forbidden`)
    })
    const frozen = await claim(contract.sessionID)
    if (!frozen) throw new Error(`Meta-harness receipt was not durably frozen for its session`)
    const winner = await read(frozen.receiptID)
    if (winner && comparable(winner, stable)) return winner
    throw new Error(`The session already has a different frozen meta-harness receipt`)
  }

  export async function read(receiptID: string) {
    const id = Hash.parse(receiptID)
    const data = await JsonStore.read(file(id))
    const parsed = Receipt.safeParse(data)
    return parsed.success && parsed.data.receiptID === id ? parsed.data : null
  }

  export function bind(contract: HarnessContract.Info, input: Receipt) {
    const receipt = Receipt.parse(input)
    const protocol = contract.metaHarness
    if (!protocol) throw new Error(`Receipt cites a meta-harness protocol that is not bound`)
    if (
      receipt.contractSHA256 !== HarnessContract.fingerprint(contract) ||
      receipt.protocolSHA256 !== digest(protocol) ||
      receipt.sourceSessionID !== contract.sessionID ||
      receipt.runID !== contract.runID
    ) {
      throw new Error(`Meta-harness receipt does not match the bound contract`)
    }
    return receipt
  }

  export async function assert(contract: HarnessContract.Info, receiptID: string) {
    const stored = await read(receiptID)
    if (!stored) throw new Error(`Unknown or corrupt meta-harness receipt ${receiptID}`)
    const receipt = bind(contract, stored)
    const active = await claim(contract.sessionID)
    if (active?.receiptID !== receipt.receiptID)
      throw new Error(`Receipt is not the session's canonical meta-harness qualification`)
    const selection = await select(contract)
    if (JSON.stringify(selection) !== JSON.stringify(receipt.selection)) {
      throw new Error(`Meta-harness receipt changed the server-selected terminal winner`)
    }
    const [state, evaluations] = await Promise.all([
      HarnessSearch.read(contract.sessionID),
      HarnessEvaluation.list(contract.sessionID),
    ])
    await validateArchive(contract.metaHarness!, receipt.archive, state, evaluations)
    await validateManifests(
      contract.metaHarness!,
      state,
      selection.candidateID,
      receipt.candidateManifestSHA256,
      receipt.protectedManifestSHA256,
    )
    validateRefinements(contract.metaHarness!, receipt.refinements, receipt.archive, selection.candidateArtifact.sha256)
    const direction = contract.benchmark.direction
    if (direction !== "maximize" && direction !== "minimize") {
      throw new Error(`Meta-harness qualification requires a numeric benchmark direction`)
    }
    const result = diagnose(contract.metaHarness!, direction, receipt.cells, receipt.refinements)
    if (
      receipt.status !== result.status ||
      JSON.stringify(receipt.diagnostics) !== JSON.stringify(result.diagnostics) ||
      JSON.stringify(receipt.failures) !== JSON.stringify(result.failures)
    ) {
      throw new Error(`Meta-harness receipt does not match the backend-derived diagnosis`)
    }
    return receipt
  }

  export async function current(contract: HarnessContract.Info) {
    if (!contract.metaHarness) return null
    const active = await claim(contract.sessionID)
    return active ? assert(contract, active.receiptID) : null
  }

  export async function assertPromotable(contract: HarnessContract.Info) {
    if (!contract.metaHarness?.promotionRequired) return null
    const receipt = await current(contract)
    if (!receipt) throw new Error(`Sealed confirmation is blocked until meta-harness qualification is recorded`)
    if (receipt.status !== "passed") {
      throw new Error(`Sealed confirmation is blocked by ${receipt.status} meta-harness qualification`)
    }
    return receipt
  }

  export function prompt(contract: HarnessContract.Info) {
    const protocol = contract.metaHarness
    if (!protocol) return ""
    return [
      "<meta-harness-policy>",
      "The base harness, evaluator, hidden tasks, and protected roots are immutable. Propose only small session-scoped deltas under the declared mutable prompt, memory, skill, tool, middleware, subagent, or scaffold roots.",
      "Every refinement must cite archived search-trace evidence, state a root cause and expected impact, and predeclare search-task flips or protected passing cells before evaluation.",
      "Retain complete candidate source, scores, and raw execution traces in the filesystem archive. Summaries are navigation aids, never substitutes for the underlying trace bytes.",
      `Qualification uses ${protocol.search.models.length} search model(s) and ${protocol.heldout.models.length} unseen model(s). Held-out task and model results never feed search, refinement, memory, or candidate selection.`,
      "A harness that is not loaded, is not followed, drifts during long trajectories, regresses one held-out model, mutates protected files, or exceeds its context budget cannot reach sealed confirmation.",
      "Meta-harness diagnostics are a promotion firewall, not the official benchmark score.",
      "</meta-harness-policy>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    return contract ? prompt(contract) : ""
  }
}
