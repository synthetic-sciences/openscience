import path from "path"
import z from "zod"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { HarnessContract } from "./contract"

export namespace HarnessFormal {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Token = z.string().min(32).max(1_024)
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

  export const FileRole = z.enum([
    "challenge",
    "statement",
    "proof",
    "lean_toolchain",
    "lake_manifest",
    "dependency_tree",
    "config",
    "support",
  ])
  export type FileRole = z.infer<typeof FileRole>

  export const File = z
    .object({
      path: z
        .string()
        .min(1)
        .max(500)
        .refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."), "Path must be relative"),
      role: FileRole,
      sha256: Hash,
    })
    .strict()
  export type File = z.infer<typeof File>

  const Build = z
    .object({
      verifierArtifactSHA256: Hash,
      exitCode: z.number().int(),
      warnings: z.number().int().nonnegative(),
      transcriptSHA256: Hash,
    })
    .strict()

  const Finding = z
    .object({
      construct: HarnessContract.FormalForbidden,
      path: File.shape.path,
      line: z.number().int().positive(),
    })
    .strict()

  const Source = z
    .object({
      verifierArtifactSHA256: Hash,
      complete: z.boolean(),
      findings: z.array(Finding).max(128),
      transcriptSHA256: Hash,
    })
    .strict()

  const Axioms = z
    .object({
      verifierArtifactSHA256: Hash,
      complete: z.boolean(),
      typesTraversed: z.boolean(),
      observed: z.array(z.string().min(1).max(300)).max(128),
      transcriptSHA256: Hash,
    })
    .strict()

  const Fresh = z
    .object({
      verifierArtifactSHA256: Hash,
      fresh: z.boolean(),
      exitCode: z.number().int(),
      transcriptSHA256: Hash,
    })
    .strict()

  const Crosscheck = z
    .object({
      role: z.enum(["lean_kernel", "external_checker"]),
      verifierArtifactSHA256: Hash,
      accepted: z.boolean(),
      transcriptSHA256: Hash,
    })
    .strict()

  const External = z
    .object({
      comparatorArtifactSHA256: Hash,
      sandboxImageSHA256: Hash,
      sandboxed: z.boolean(),
      challengeMatched: z.boolean(),
      proofTermSHA256: Hash,
      transcriptSHA256: Hash,
      checks: z.array(Crosscheck).min(2).max(2),
    })
    .strict()

  export const Submit = Access.extend({
    subject: Subject,
    artifactSHA256: Hash,
    relation: HarnessContract.FormalRelation,
    challengeSHA256: Hash,
    statementSHA256: Hash,
    declaration: z.string().min(1).max(500),
    module: z.string().min(1).max(500),
    environment: z
      .object({
        leanVersion: z.string().min(1).max(200),
        leanToolchainSHA256: Hash,
        lakeManifestSHA256: Hash,
        dependencyTreeSHA256: Hash,
      })
      .strict(),
    manifest: z
      .object({
        complete: z.boolean(),
        files: z.array(File).min(6).max(10_000),
      })
      .strict(),
    verification: z
      .object({
        startedAt: z.number().int().positive(),
        endedAt: z.number().int().positive(),
        build: Build,
        source: Source,
        axioms: Axioms,
        fresh: Fresh.optional(),
        external: External.optional(),
      })
      .strict(),
  }).strict()
  export type Submit = z.infer<typeof Submit>

  export const Metrics = z
    .object({
      files: z.number().int().positive(),
      warnings: z.number().int().nonnegative(),
      observedAxioms: z.number().int().nonnegative(),
      disallowedAxioms: z.array(z.string().min(1).max(300)).max(128),
      manifestComplete: z.boolean(),
      buildAccepted: z.boolean(),
      sourceAuditAccepted: z.boolean(),
      forbiddenFindings: z.array(Finding).max(128),
      axiomAuditAccepted: z.boolean(),
      freshRecheckAccepted: z.boolean(),
      externalCrosscheckAccepted: z.boolean(),
      statementMatched: z.boolean(),
    })
    .strict()
  export type Metrics = z.infer<typeof Metrics>

  export const Receipt = z
    .object({
      schemaVersion: z.literal(1),
      protocolVersion: z.literal("formal-proof-receipt-v1"),
      receiptID: Hash,
      runID: z.string().min(1).max(240),
      sessionID: z.string().min(1).max(240),
      contractFingerprint: Hash,
      protocolSHA256: Hash,
      subject: Subject,
      artifactSHA256: Hash,
      relation: HarnessContract.FormalRelation,
      challengeSHA256: Hash,
      statementSHA256: Hash,
      declaration: z.string().min(1).max(500),
      module: z.string().min(1).max(500),
      environment: Submit.shape.environment,
      manifestSHA256: Hash,
      files: z.array(File).min(6).max(10_000),
      verification: Submit.shape.verification,
      tier: HarnessContract.FormalTier,
      metrics: Metrics,
      status: z.enum(["passed", "failed"]),
      failures: z.array(z.string().min(1).max(500)).max(32),
      recordedAt: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const stable = structuredClone(value) as Record<string, unknown>
      delete stable.receiptID
      delete stable.recordedAt
      if (digest(stable) === value.receiptID) return
      ctx.addIssue({ code: "custom", path: ["receiptID"], message: "Formal proof receipt hash is invalid" })
    })
  export type Receipt = z.infer<typeof Receipt>

  export function prompt(contract: HarnessContract.Info) {
    const protocol = contract.formalProof
    if (!protocol) return ""
    return [
      '<formal-proof-policy verifier="evaluator">',
      `Produce a Lean 4 ${protocol.relation} for the frozen declaration ${protocol.declaration} in ${protocol.module}.`,
      `The trusted challenge, canonical statement, toolchain, dependency graph, verifier artifacts, and ${protocol.tier} trust tier are immutable.`,
      "A successful build alone is insufficient: transitive axiom use is audited, and higher tiers require a fresh kernel replay or sandboxed independent cross-check.",
      "Do not use sorry, debug.skipKernelTC, an undeclared axiom, a substituted statement, or a repaired theorem when the contract requires an exact proof.",
      "Formal verification proves the frozen Lean statement only; semantic correspondence to informal mathematics remains a separate review obligation.",
      "</formal-proof-policy>",
    ].join("\n")
  }

  export async function context(sessionID: string) {
    const contract = await HarnessContract.read(sessionID)
    return contract ? prompt(contract) : ""
  }

  const root = path.join(Global.Path.data, "harness", "formal")
  const receiptFile = (receiptID: string) => path.join(root, "receipts", `${receiptID}.json`)
  const subjectFile = (sessionID: string, subject: Subject) =>
    path.join(
      root,
      "subjects",
      encodeURIComponent(sessionID),
      `${encodeURIComponent(`${subject.type}:${subject.id}`)}.json`,
    )

  async function target(contract: HarnessContract.Info, subject: Subject) {
    if (subject.type === "run") {
      if (subject.id !== contract.runID) throw new Error(`Formal proof run subject does not match its contract`)
      return { createdAt: contract.createdAt }
    }
    const state = await import("./search")
      .then((module) => module.HarnessSearch.read(contract.sessionID))
      .catch(() => null)
    const candidate = state?.runID === contract.runID ? state.candidates[subject.id] : undefined
    if (!candidate) throw new Error(`Formal proof candidate does not exist in the bound search`)
    return { createdAt: candidate.createdAt, artifactSHA256: candidate.artifact.sha256 }
  }

  const verifier = (protocol: HarnessContract.FormalProof, role: HarnessContract.FormalVerifierRole) => {
    const item = protocol.verifiers.find((entry) => entry.role === role)
    if (!item) throw new Error(`Formal proof protocol has no ${role} verifier`)
    return item
  }

  function manifest(files: File[], max: number) {
    if (files.length > max) throw new Error(`Formal proof manifest exceeds its frozen file budget`)
    const parsed = files.map((item) => File.parse(item))
    if (new Set(parsed.map((item) => item.path)).size !== parsed.length) {
      throw new Error(`Formal proof manifest paths must be unique`)
    }
    if (parsed.some((item, index) => Boolean(index) && parsed[index - 1]!.path.localeCompare(item.path) >= 0)) {
      throw new Error(`Formal proof manifest files must use canonical path order`)
    }
    for (const role of [
      "challenge",
      "statement",
      "proof",
      "lean_toolchain",
      "lake_manifest",
      "dependency_tree",
    ] as const) {
      if (parsed.filter((item) => item.role === role).length !== 1) {
        throw new Error(`Formal proof manifest requires exactly one ${role} file`)
      }
    }
    return parsed
  }

  function identities(input: Submit, protocol: HarnessContract.FormalProof) {
    if (input.verification.build.verifierArtifactSHA256 !== verifier(protocol, "lean_kernel").artifactSHA256) {
      throw new Error(`Formal proof build used an unbound Lean kernel`)
    }
    if (input.verification.source.verifierArtifactSHA256 !== verifier(protocol, "source_auditor").artifactSHA256) {
      throw new Error(`Formal proof source audit used an unbound verifier`)
    }
    if (input.verification.axioms.verifierArtifactSHA256 !== verifier(protocol, "axiom_auditor").artifactSHA256) {
      throw new Error(`Formal proof axiom audit used an unbound verifier`)
    }
    const fresh = protocol.tier !== "kernel"
    if (Boolean(input.verification.fresh) !== fresh) {
      throw new Error(`Formal proof submission does not match its frozen fresh-recheck tier`)
    }
    if (
      input.verification.fresh &&
      input.verification.fresh.verifierArtifactSHA256 !== verifier(protocol, "fresh_rechecker").artifactSHA256
    ) {
      throw new Error(`Formal proof fresh replay used an unbound verifier`)
    }
    const external = protocol.tier === "external_crosscheck"
    if (Boolean(input.verification.external) !== external) {
      throw new Error(`Formal proof submission does not match its frozen external-check tier`)
    }
    if (!input.verification.external) return
    if (
      input.verification.external.comparatorArtifactSHA256 !==
        verifier(protocol, "sandbox_comparator").artifactSHA256 ||
      input.verification.external.sandboxImageSHA256 !== protocol.sandboxImageSHA256
    ) {
      throw new Error(`Formal proof external replay changed its comparator or sandbox`)
    }
    const checks = input.verification.external.checks
    if (new Set(checks.map((item) => item.role)).size !== checks.length) {
      throw new Error(`Formal proof external checker roles must be unique`)
    }
    for (const role of ["lean_kernel", "external_checker"] as const) {
      const check = checks.find((item) => item.role === role)
      if (!check || check.verifierArtifactSHA256 !== verifier(protocol, role).artifactSHA256) {
        throw new Error(`Formal proof external replay changed its ${role} verifier`)
      }
    }
  }

  function assess(input: { protocol: HarnessContract.FormalProof; value: Submit; files: File[] }) {
    const observed = input.value.verification.axioms.observed
    const disallowedAxioms = observed.filter((item) => !input.protocol.allowedAxioms.includes(item))
    const buildAccepted = input.value.verification.build.exitCode === 0 && input.value.verification.build.warnings === 0
    const sourceAuditAccepted =
      input.value.verification.source.complete && !input.value.verification.source.findings.length
    const axiomAuditAccepted =
      input.value.verification.axioms.complete &&
      input.value.verification.axioms.typesTraversed &&
      !disallowedAxioms.length
    const freshRecheckAccepted =
      input.protocol.tier === "kernel" ||
      Boolean(input.value.verification.fresh?.fresh && input.value.verification.fresh.exitCode === 0)
    const external = input.value.verification.external
    const statementMatched = input.protocol.tier !== "external_crosscheck" || Boolean(external?.challengeMatched)
    const externalCrosscheckAccepted =
      input.protocol.tier !== "external_crosscheck" ||
      Boolean(external?.sandboxed && external.challengeMatched && external.checks.every((item) => item.accepted))
    const metrics = Metrics.parse({
      files: input.files.length,
      warnings: input.value.verification.build.warnings,
      observedAxioms: observed.length,
      disallowedAxioms,
      manifestComplete: input.value.manifest.complete,
      buildAccepted,
      sourceAuditAccepted,
      forbiddenFindings: input.value.verification.source.findings,
      axiomAuditAccepted,
      freshRecheckAccepted,
      externalCrosscheckAccepted,
      statementMatched,
    })
    const failures = [
      ...(!metrics.manifestComplete ? ["proof manifest is not complete"] : []),
      ...(!metrics.buildAccepted ? ["Lean build failed or emitted warnings"] : []),
      ...(!input.value.verification.source.complete ? ["source audit is incomplete"] : []),
      ...input.value.verification.source.findings.map(
        (item) => `forbidden construct ${item.construct} at ${item.path}:${item.line}`,
      ),
      ...(!input.value.verification.axioms.complete ? ["transitive axiom inventory is incomplete"] : []),
      ...(!input.value.verification.axioms.typesTraversed ? ["axiom audit did not traverse axiom types"] : []),
      ...disallowedAxioms.map((item) => `disallowed axiom: ${item}`),
      ...(!metrics.freshRecheckAccepted ? ["fresh kernel replay failed"] : []),
      ...(!metrics.statementMatched ? ["external comparator did not match the trusted challenge"] : []),
      ...(!metrics.externalCrosscheckAccepted ? ["sandboxed independent cross-check failed"] : []),
    ]
    return { metrics, status: failures.length ? ("failed" as const) : ("passed" as const), failures }
  }

  function verify(receipt: Receipt, protocol: HarnessContract.FormalProof) {
    if (
      receipt.relation !== protocol.relation ||
      receipt.challengeSHA256 !== protocol.challengeSHA256 ||
      receipt.statementSHA256 !== protocol.statementSHA256 ||
      receipt.declaration !== protocol.declaration ||
      receipt.module !== protocol.module ||
      receipt.tier !== protocol.tier
    ) {
      throw new Error(`Formal proof receipt changed its frozen theorem identity`)
    }
    if (
      receipt.environment.leanVersion !== protocol.leanVersion ||
      receipt.environment.leanToolchainSHA256 !== protocol.leanToolchainSHA256 ||
      receipt.environment.lakeManifestSHA256 !== protocol.lakeManifestSHA256 ||
      receipt.environment.dependencyTreeSHA256 !== protocol.dependencyTreeSHA256
    ) {
      throw new Error(`Formal proof receipt changed its frozen Lean environment`)
    }
    const files = manifest(receipt.files, protocol.maxFiles)
    if (digest(files) !== receipt.manifestSHA256) {
      throw new Error(`Formal proof receipt does not match its file manifest`)
    }
    const value = Submit.parse({
      sessionID: receipt.sessionID,
      evaluatorToken: "receipt-verification-token-0000000000000000",
      subject: receipt.subject,
      artifactSHA256: receipt.artifactSHA256,
      relation: receipt.relation,
      challengeSHA256: receipt.challengeSHA256,
      statementSHA256: receipt.statementSHA256,
      declaration: receipt.declaration,
      module: receipt.module,
      environment: receipt.environment,
      manifest: { complete: receipt.metrics.manifestComplete, files },
      verification: receipt.verification,
    })
    identities(value, protocol)
    const result = assess({ protocol, value, files })
    if (
      !same(result.metrics, receipt.metrics) ||
      result.status !== receipt.status ||
      !same(result.failures, receipt.failures)
    ) {
      throw new Error(`Formal proof receipt does not match backend-derived verification`)
    }
  }

  export async function record(input: Submit, contract: HarnessContract.Info) {
    const value = Submit.parse(input)
    if (value.sessionID !== contract.sessionID) {
      throw new Error(`Formal proof session does not match its bound harness contract`)
    }
    const protocol = contract.formalProof
    if (!protocol) throw new Error(`Harness contract does not require formal proof validation`)
    if (
      value.relation !== protocol.relation ||
      value.challengeSHA256 !== protocol.challengeSHA256 ||
      value.statementSHA256 !== protocol.statementSHA256 ||
      value.declaration !== protocol.declaration ||
      value.module !== protocol.module
    ) {
      throw new Error(`Formal proof submission changed the frozen theorem or claim relation`)
    }
    if (
      value.environment.leanVersion !== protocol.leanVersion ||
      value.environment.leanToolchainSHA256 !== protocol.leanToolchainSHA256 ||
      value.environment.lakeManifestSHA256 !== protocol.lakeManifestSHA256 ||
      value.environment.dependencyTreeSHA256 !== protocol.dependencyTreeSHA256
    ) {
      throw new Error(`Formal proof submission changed the frozen Lean environment`)
    }
    if (value.verification.endedAt < value.verification.startedAt) {
      throw new Error(`Formal proof verification ends before it starts`)
    }
    const recordedAt = Date.now()
    const subject = await target(contract, value.subject)
    if (value.verification.startedAt < subject.createdAt || value.verification.endedAt > recordedAt) {
      throw new Error(`Formal proof verification falls outside its bound subject interval`)
    }
    if (subject.artifactSHA256 && subject.artifactSHA256 !== value.artifactSHA256) {
      throw new Error(`Formal proof receipt changed the candidate artifact`)
    }
    identities(value, protocol)
    const files = manifest(value.manifest.files, protocol.maxFiles)
    const byRole = (role: FileRole) => files.find((item) => item.role === role)!
    if (
      byRole("challenge").sha256 !== value.challengeSHA256 ||
      byRole("statement").sha256 !== value.statementSHA256 ||
      byRole("proof").sha256 !== value.artifactSHA256 ||
      byRole("lean_toolchain").sha256 !== value.environment.leanToolchainSHA256 ||
      byRole("lake_manifest").sha256 !== value.environment.lakeManifestSHA256 ||
      byRole("dependency_tree").sha256 !== value.environment.dependencyTreeSHA256
    ) {
      throw new Error(`Formal proof manifest does not bind its challenge, proof, or environment artifacts`)
    }
    if (
      new Set(value.verification.axioms.observed).size !== value.verification.axioms.observed.length ||
      value.verification.axioms.observed.some(
        (item, index) => Boolean(index) && value.verification.axioms.observed[index - 1]!.localeCompare(item) >= 0,
      )
    ) {
      throw new Error(`Formal proof observed axioms must be unique and use canonical order`)
    }
    const findings = value.verification.source.findings
    const keys = findings.map(
      (item) => `${item.path}\u0000${item.line.toString().padStart(12, "0")}\u0000${item.construct}`,
    )
    if (
      new Set(keys).size !== keys.length ||
      keys.some((item, index) => Boolean(index) && keys[index - 1]!.localeCompare(item) >= 0)
    ) {
      throw new Error(`Formal proof source findings must be unique and use canonical order`)
    }
    if (findings.some((item) => !files.some((file) => file.path === item.path))) {
      throw new Error(`Formal proof source finding references a file outside the complete manifest`)
    }
    const result = assess({ protocol, value, files })
    const stable = {
      schemaVersion: 1 as const,
      protocolVersion: "formal-proof-receipt-v1" as const,
      runID: contract.runID,
      sessionID: contract.sessionID,
      contractFingerprint: HarnessContract.fingerprint(contract),
      protocolSHA256: digest(protocol),
      subject: value.subject,
      artifactSHA256: value.artifactSHA256,
      relation: value.relation,
      challengeSHA256: value.challengeSHA256,
      statementSHA256: value.statementSHA256,
      declaration: value.declaration,
      module: value.module,
      environment: value.environment,
      manifestSHA256: digest(files),
      files,
      verification: value.verification,
      tier: protocol.tier,
      metrics: result.metrics,
      status: result.status,
      failures: result.failures,
    }
    const receipt = Receipt.parse({ ...stable, receiptID: digest(stable), recordedAt })
    const claimed = await JsonStore.read(subjectFile(receipt.sessionID, receipt.subject))
    if (Object.keys(claimed).length) {
      const current = Receipt.parse(claimed)
      if (current.receiptID !== receipt.receiptID) {
        throw new Error(`Formal proof subject already has a canonical receipt`)
      }
    }
    await JsonStore.update(receiptFile(receipt.receiptID), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Formal proof receipt is immutable once recorded`)
    })
    await JsonStore.update(subjectFile(receipt.sessionID, receipt.subject), (data) => {
      if (!Object.keys(data).length) return receipt
      const current = Receipt.parse(data)
      if (current.receiptID === receipt.receiptID) return current
      throw new Error(`Formal proof subject already has a canonical receipt`)
    })
    const saved = await readReceipt(receipt.receiptID)
    if (!saved) throw new Error(`Formal proof receipt was not durable after recording`)
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
    if (!receipt || receipt.sessionID !== contract.sessionID)
      throw new Error(`Unknown formal proof receipt ${receiptID}`)
    const protocol = contract.formalProof
    if (!protocol || receipt.contractFingerprint !== HarnessContract.fingerprint(contract)) {
      throw new Error(`Formal proof receipt belongs to a different harness run`)
    }
    verify(receipt, protocol)
    const subject = await target(contract, receipt.subject)
    if (
      receipt.verification.startedAt < subject.createdAt ||
      receipt.verification.endedAt > receipt.recordedAt ||
      (subject.artifactSHA256 && subject.artifactSHA256 !== receipt.artifactSHA256)
    ) {
      throw new Error(`Formal proof receipt changed its bound subject, artifact, or interval`)
    }
    return receipt
  }

  export async function assert(input: {
    contract: HarnessContract.Info
    receiptID: string
    subject: Subject
    evaluatedAt: number
    recordedAt: number
    requirePassed: boolean
  }) {
    const receipt = await readReceipt(input.receiptID)
    if (!receipt) throw new Error(`Unknown or corrupt formal proof receipt ${input.receiptID}`)
    const protocol = input.contract.formalProof
    if (!protocol) throw new Error(`Evaluation cites a formal proof receipt without a bound protocol`)
    if (
      receipt.contractFingerprint !== HarnessContract.fingerprint(input.contract) ||
      receipt.protocolSHA256 !== digest(protocol) ||
      receipt.sessionID !== input.contract.sessionID ||
      receipt.runID !== input.contract.runID
    ) {
      throw new Error(`Formal proof receipt belongs to a different harness run`)
    }
    verify(receipt, protocol)
    if (receipt.subject.type !== input.subject.type || receipt.subject.id !== input.subject.id) {
      throw new Error(`Formal proof receipt belongs to a different evaluation subject`)
    }
    const subject = await target(input.contract, input.subject)
    if (
      receipt.verification.startedAt < subject.createdAt ||
      receipt.verification.endedAt > receipt.recordedAt ||
      (subject.artifactSHA256 && subject.artifactSHA256 !== receipt.artifactSHA256)
    ) {
      throw new Error(`Formal proof receipt belongs to a different subject artifact or interval`)
    }
    if (
      receipt.verification.endedAt > input.evaluatedAt ||
      receipt.recordedAt > input.evaluatedAt ||
      receipt.recordedAt > input.recordedAt
    ) {
      throw new Error(`Evaluation predates its formal proof receipt`)
    }
    if (input.requirePassed && receipt.status !== "passed") {
      throw new Error(`A passing final evaluation requires a passing formal proof receipt`)
    }
    return receipt
  }
}
