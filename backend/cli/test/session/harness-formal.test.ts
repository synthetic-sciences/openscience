import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessFormal } from "../../src/session/harness/formal"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const receipts = new Set<string>()
const evaluator = "formal-proof-evaluator-token-000000000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

const verifier = (role: HarnessContract.FormalVerifierRole) => ({
  role,
  name: `test-${role}`,
  version: "1",
  artifactSHA256: hash(`verifier-${role}`),
})

function protocol(
  tier: HarnessContract.FormalTier = "kernel",
  relation: HarnessContract.FormalRelation = "exact_proof",
) {
  const roles =
    tier === "kernel"
      ? (["lean_kernel", "source_auditor", "axiom_auditor"] as const)
      : tier === "fresh_recheck"
        ? (["lean_kernel", "source_auditor", "axiom_auditor", "fresh_rechecker"] as const)
        : HarnessContract.FormalVerifierRole.options
  return HarnessContract.FormalProof.parse({
    protocolVersion: "formal-proof-v1",
    language: "lean4",
    tier,
    relation,
    challengeSHA256: hash(`challenge-${relation}`),
    statementSHA256: hash(`statement-${relation}`),
    declaration: `OpenScience.${relation}`,
    module: "OpenScience.Proof",
    leanVersion: "4.33.0",
    leanToolchainSHA256: hash("lean-toolchain"),
    lakeManifestSHA256: hash("lake-manifest"),
    dependencyTreeSHA256: hash("dependency-tree"),
    verifiers: roles.map(verifier),
    ...(tier === "external_crosscheck" ? { sandboxImageSHA256: hash("formal-sandbox") } : {}),
    forbiddenConstructs: HarnessContract.FormalForbidden.options,
    allowedAxioms: ["Classical.choice", "Quot.sound", "propext"].toSorted((a, b) => a.localeCompare(b)),
    maxFiles: 32,
    completeManifestRequired: true,
    warningPolicy: "fail",
    semanticPolicy: "formal_statement_only",
  })
}

function task(
  sessionID: string,
  tier: HarnessContract.FormalTier = "kernel",
  relation: HarnessContract.FormalRelation = "exact_proof",
): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "formal-proof",
    split: "validation",
    evaluator: { name: "official-formal-evaluator", version: "1", source: "benchmark", token: evaluator },
    formalProof: protocol(tier, relation),
    objective: "Produce the exact frozen Lean result under the declared proof relation",
    metric: { name: "accuracy", direction: "maximize", target: 0.8 },
    model: { provider: "test", name: "formal-agent" },
    tools: ["read", "bash"],
    skills: [{ name: "verify-formal-proof" }],
    budget: { steps: 20 },
    profile: "react",
    seed: 47,
    intervention: "autonomous",
    contamination: { policy: "trusted challenge remains evaluator-owned", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const bound = (contract: HarnessContract.Info, role: HarnessContract.FormalVerifierRole) =>
  contract.formalProof!.verifiers.find((item) => item.role === role)!.artifactSHA256

function submit(
  contract: HarnessContract.Info,
  input: {
    subject?: HarnessFormal.Subject
    artifactSHA256?: string
    startedAt?: number
    warnings?: number
    sourceComplete?: boolean
    findings?: { construct: HarnessContract.FormalForbidden; path: string; line: number }[]
    observed?: string[]
    complete?: boolean
    typesTraversed?: boolean
    fresh?: boolean
    freshExitCode?: number
    sandboxed?: boolean
    challengeMatched?: boolean
    externalAccepted?: boolean
  } = {},
) {
  if (!contract.formalProof) throw new Error("Expected formal proof protocol")
  const artifactSHA256 = input.artifactSHA256 ?? hash(`${contract.sessionID}-proof`)
  const files = [
    { path: "challenge.lean", role: "challenge" as const, sha256: contract.formalProof.challengeSHA256 },
    { path: "deps.json", role: "dependency_tree" as const, sha256: contract.formalProof.dependencyTreeSHA256 },
    { path: "lake-manifest.json", role: "lake_manifest" as const, sha256: contract.formalProof.lakeManifestSHA256 },
    {
      path: "lean-toolchain",
      role: "lean_toolchain" as const,
      sha256: contract.formalProof.leanToolchainSHA256,
    },
    { path: "proof.lean", role: "proof" as const, sha256: artifactSHA256 },
    { path: "statement.lean", role: "statement" as const, sha256: contract.formalProof.statementSHA256 },
  ]
  const startedAt = input.startedAt ?? contract.createdAt
  const endedAt = Math.max(Date.now(), startedAt)
  const tier = contract.formalProof.tier
  return HarnessFormal.Submit.parse({
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    subject: input.subject ?? { type: "run", id: contract.runID },
    artifactSHA256,
    relation: contract.formalProof.relation,
    challengeSHA256: contract.formalProof.challengeSHA256,
    statementSHA256: contract.formalProof.statementSHA256,
    declaration: contract.formalProof.declaration,
    module: contract.formalProof.module,
    environment: {
      leanVersion: contract.formalProof.leanVersion,
      leanToolchainSHA256: contract.formalProof.leanToolchainSHA256,
      lakeManifestSHA256: contract.formalProof.lakeManifestSHA256,
      dependencyTreeSHA256: contract.formalProof.dependencyTreeSHA256,
    },
    manifest: { complete: input.complete ?? true, files },
    verification: {
      startedAt,
      endedAt,
      build: {
        verifierArtifactSHA256: bound(contract, "lean_kernel"),
        exitCode: 0,
        warnings: input.warnings ?? 0,
        transcriptSHA256: hash(`${contract.sessionID}-build`),
      },
      source: {
        verifierArtifactSHA256: bound(contract, "source_auditor"),
        complete: input.sourceComplete ?? true,
        findings: input.findings ?? [],
        transcriptSHA256: hash(`${contract.sessionID}-source`),
      },
      axioms: {
        verifierArtifactSHA256: bound(contract, "axiom_auditor"),
        complete: true,
        typesTraversed: input.typesTraversed ?? true,
        observed: input.observed ?? contract.formalProof.allowedAxioms,
        transcriptSHA256: hash(`${contract.sessionID}-axioms`),
      },
      ...(tier === "kernel"
        ? {}
        : {
            fresh: {
              verifierArtifactSHA256: bound(contract, "fresh_rechecker"),
              fresh: input.fresh ?? true,
              exitCode: input.freshExitCode ?? 0,
              transcriptSHA256: hash(`${contract.sessionID}-fresh`),
            },
          }),
      ...(tier === "external_crosscheck"
        ? {
            external: {
              comparatorArtifactSHA256: bound(contract, "sandbox_comparator"),
              sandboxImageSHA256: contract.formalProof.sandboxImageSHA256,
              sandboxed: input.sandboxed ?? true,
              challengeMatched: input.challengeMatched ?? true,
              proofTermSHA256: hash(`${contract.sessionID}-proof-term`),
              transcriptSHA256: hash(`${contract.sessionID}-comparator`),
              checks: [
                {
                  role: "lean_kernel",
                  verifierArtifactSHA256: bound(contract, "lean_kernel"),
                  accepted: true,
                  transcriptSHA256: hash(`${contract.sessionID}-external-lean`),
                },
                {
                  role: "external_checker",
                  verifierArtifactSHA256: bound(contract, "external_checker"),
                  accepted: input.externalAccepted ?? true,
                  transcriptSHA256: hash(`${contract.sessionID}-external-independent`),
                },
              ],
            },
          }
        : {}),
    },
  })
}

const checks = (contract: HarnessContract.Info) =>
  HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`evidence://${check.id}`],
  }))

function evaluation(contract: HarnessContract.Info, receipt?: HarnessFormal.Receipt) {
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    proofReceiptID: receipt?.receiptID,
    status: "passed",
    score: 0.9,
    metrics: { accuracy: 0.9 },
    checks: checks(contract),
    evidence: ["official://formal-proof-result"],
    evaluatedAt: Math.max(Date.now(), receipt?.recordedAt ?? contract.createdAt),
  })
}

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) => [
      ...["bindings", "contracts", "evaluations", "reports", "search", "retrospectives"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
      fs.rm(path.join(Global.Path.data, "harness", "formal", "subjects", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ]),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "formal", "receipts", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  receipts.clear()
})

describe("formal proof receipts", () => {
  test("binds an exact kernel proof and gates final reporting", async () => {
    const contract = await HarnessAdapter.bind(task("formal-pass"))
    expect(contract.packs).toContain("formal")
    expect(HarnessFormal.prompt(contract)).toContain("exact_proof")
    expect(HarnessFormal.prompt(contract)).not.toContain(contract.formalProof!.challengeSHA256)
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("formal proof receipt")

    const receipt = await HarnessFormal.record(submit(contract), contract)
    receipts.add(receipt.receiptID)
    expect(receipt).toMatchObject({
      status: "passed",
      tier: "kernel",
      relation: "exact_proof",
      metrics: { buildAccepted: true, sourceAuditAccepted: true, axiomAuditAccepted: true, files: 6 },
    })
    expect(JSON.stringify(receipt)).not.toContain(evaluator)
    await expect(
      HarnessAdapter.ingest({ ...evaluation(contract, receipt), evaluatedAt: receipt.recordedAt - 1 }),
    ).rejects.toThrow("predates")

    const result = await HarnessAdapter.ingest(evaluation(contract, receipt))
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation], formal: receipt })
    expect(report.execution.formal).toEqual({ tier: "kernel", relation: "exact_proof", status: "passed" })
    expect(report.quality.proofReceiptID).toBe(receipt.receiptID)
    const stronger = HarnessContract.Info.parse({
      ...contract,
      runID: `${contract.runID}-fresh`,
      sessionID: `${contract.sessionID}-fresh`,
      formalProof: protocol("fresh_recheck"),
    })
    expect(report.comparisonKey).not.toBe(HarnessReport.compile({ contract: stronger, evaluations: [] }).comparisonKey)
  })

  test("fails warnings, unchecked source constructs, incomplete axiom traversal, and disallowed axioms", async () => {
    const warningContract = await HarnessAdapter.bind(task("formal-warning"))
    const warning = await HarnessFormal.record(submit(warningContract, { warnings: 1 }), warningContract)
    receipts.add(warning.receiptID)
    expect(warning.status).toBe("failed")
    expect(warning.failures).toContain("Lean build failed or emitted warnings")

    const sourceContract = await HarnessAdapter.bind(task("formal-source-audit"))
    const source = await HarnessFormal.record(
      submit(sourceContract, {
        findings: [{ construct: "debug.skipKernelTC", path: "proof.lean", line: 7 }],
      }),
      sourceContract,
    )
    receipts.add(source.receiptID)
    expect(source.metrics.sourceAuditAccepted).toBe(false)
    expect(source.failures).toContain("forbidden construct debug.skipKernelTC at proof.lean:7")

    const traversalContract = await HarnessAdapter.bind(task("formal-axiom-types"))
    const traversal = await HarnessFormal.record(
      submit(traversalContract, { typesTraversed: false }),
      traversalContract,
    )
    receipts.add(traversal.receiptID)
    expect(traversal.failures).toContain("axiom audit did not traverse axiom types")

    const sorryContract = await HarnessAdapter.bind(task("formal-sorry"))
    const sorry = await HarnessFormal.record(
      submit(sorryContract, {
        observed: [...sorryContract.formalProof!.allowedAxioms, "sorryAx"].toSorted((a, b) => a.localeCompare(b)),
      }),
      sorryContract,
    )
    receipts.add(sorry.receiptID)
    expect(sorry.failures).toContain("disallowed axiom: sorryAx")
    await expect(HarnessAdapter.ingest(evaluation(sorryContract, sorry))).rejects.toThrow(
      "passing formal proof receipt",
    )

    expect(() =>
      HarnessContract.FormalProof.parse({ ...protocol(), allowedAxioms: ["Classical.choice", "sorryAx"] }),
    ).toThrow("never allow sorryAx")
    expect(() =>
      HarnessContract.FormalProof.parse({ ...protocol(), forbiddenConstructs: ["sorry", "admit"] }),
    ).toThrow()
  })

  test("enforces fresh replay and sandboxed independent checker tiers", async () => {
    const freshContract = await HarnessAdapter.bind(task("formal-fresh", "fresh_recheck"))
    const failedFresh = await HarnessFormal.record(submit(freshContract, { fresh: false }), freshContract)
    receipts.add(failedFresh.receiptID)
    expect(failedFresh.failures).toContain("fresh kernel replay failed")

    const missing = submit(freshContract)
    delete missing.verification.fresh
    await expect(HarnessFormal.record(missing, freshContract)).rejects.toThrow("fresh-recheck tier")

    const externalContract = await HarnessAdapter.bind(task("formal-external", "external_crosscheck"))
    const failedExternal = await HarnessFormal.record(
      submit(externalContract, { challengeMatched: false, externalAccepted: false }),
      externalContract,
    )
    receipts.add(failedExternal.receiptID)
    expect(failedExternal.failures).toContain("external comparator did not match the trusted challenge")
    expect(failedExternal.failures).toContain("sandboxed independent cross-check failed")

    const swapped = submit(externalContract)
    swapped.verification.external!.checks[1]!.verifierArtifactSHA256 = hash("substituted-external-checker")
    await expect(HarnessFormal.record(swapped, externalContract)).rejects.toThrow("external_checker verifier")

    const passContract = await HarnessAdapter.bind(task("formal-external-pass", "external_crosscheck"))
    const passed = await HarnessFormal.record(submit(passContract), passContract)
    receipts.add(passed.receiptID)
    expect(passed).toMatchObject({ status: "passed", tier: "external_crosscheck" })
  })

  test("rejects relation, environment, manifest, candidate, and canonical-receipt laundering", async () => {
    const changed = task("formal-candidate")
    changed.profile = "optimize"
    changed.budget = { ...changed.budget, candidates: 2 }
    const contract = await HarnessAdapter.bind(changed)
    await HarnessSearch.initialize({ sessionID: contract.sessionID })
    const recommendation = HarnessSearch.recommend(await HarnessSearch.read(contract.sessionID))
    const artifactSHA256 = hash("formal-registered-candidate")
    const candidate = await HarnessSearch.add({
      sessionID: contract.sessionID,
      recommendationID: recommendation.id,
      parentIDs: recommendation.parentIDs,
      inspirationIDs: recommendation.inspirationIDs,
      branch: "formal",
      proposal: "candidate Lean proof",
      artifact: { uri: "candidate://formal-proof", sha256: artifactSHA256 },
    })
    const subject = { type: "candidate" as const, id: candidate.id }
    const startedAt = Date.now()
    await expect(
      HarnessFormal.record(
        submit(contract, { subject, artifactSHA256: hash("substituted-proof"), startedAt }),
        contract,
      ),
    ).rejects.toThrow("changed the candidate artifact")

    const relation = submit(contract, { subject, artifactSHA256, startedAt })
    relation.relation = "repaired_proof"
    await expect(HarnessFormal.record(relation, contract)).rejects.toThrow("claim relation")
    const environment = submit(contract, { subject, artifactSHA256, startedAt })
    environment.environment.leanVersion = "4.34.0"
    await expect(HarnessFormal.record(environment, contract)).rejects.toThrow("Lean environment")
    const manifest = submit(contract, { subject, artifactSHA256, startedAt })
    manifest.manifest.files[4]!.sha256 = hash("manifest-proof-swap")
    await expect(HarnessFormal.record(manifest, contract)).rejects.toThrow("manifest does not bind")
    const auditor = submit(contract, { subject, artifactSHA256, startedAt })
    auditor.verification.source.verifierArtifactSHA256 = hash("substituted-source-auditor")
    await expect(HarnessFormal.record(auditor, contract)).rejects.toThrow("source audit used an unbound verifier")
    const outside = submit(contract, {
      subject,
      artifactSHA256,
      startedAt,
      findings: [{ construct: "sorry", path: "unlisted.lean", line: 1 }],
    })
    await expect(HarnessFormal.record(outside, contract)).rejects.toThrow("outside the complete manifest")

    const receipt = await HarnessFormal.record(submit(contract, { subject, artifactSHA256, startedAt }), contract)
    receipts.add(receipt.receiptID)
    const replacement = submit(contract, {
      subject,
      artifactSHA256,
      observed: [],
      startedAt,
    })
    await expect(HarnessFormal.record(replacement, contract)).rejects.toThrow("canonical receipt")
  })

  test("protects proof routes with evaluator capability and fails closed on disk tampering", async () => {
    const contract = await HarnessAdapter.bind(task("formal-route"))
    const app = HarnessRoutes()
    const response = await app.request("/proofs/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submit(contract)),
    })
    expect(response.status).toBe(200)
    const receipt = HarnessFormal.Receipt.parse(await response.json())
    receipts.add(receipt.receiptID)

    await expect(
      HarnessAdapter.authorize(contract.sessionID, "wrong-formal-proof-token-000000000000000000"),
    ).rejects.toThrow("capability was rejected")
    const read = await app.request(`/proofs/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: evaluator }),
    })
    expect(read.status).toBe(200)

    const file = path.join(Global.Path.data, "harness", "formal", "receipts", `${receipt.receiptID}.json`)
    await Bun.write(file, JSON.stringify({ ...receipt, status: "failed" }))
    expect(await HarnessFormal.readReceipt(receipt.receiptID)).toBeNull()
  })
})
