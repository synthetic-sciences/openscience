import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessConfirmation } from "../../src/session/harness/confirmation"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessEvolution } from "../../src/session/harness/evolution"
import { HarnessMeta } from "../../src/session/harness/meta"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const receipts = new Set<string>()
const directories = new Set<string>()
const evaluatorToken = "meta-optimization-evaluator-capability-000000000000"
const metaToken = "meta-independent-qualifier-capability-0000000000000"
const confirmationToken = "meta-claim-evaluator-capability-0000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
const protectedFiles = [
  { path: "evaluator/runner.md", sha256: hash("frozen evaluator\n") },
  { path: "tests/contract.md", sha256: hash("frozen tests\n") },
]

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "evolution", "meta", "reports", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await Promise.all(
    [...sessions].map((sessionID) =>
      fs.rm(path.join(Global.Path.data, "harness", "meta", "sessions", `${digest(sessionID)}.json`), { force: true }),
    ),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "meta", `${receiptID}.json`), { force: true }),
    ),
  )
  await Promise.all([...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })))
  sessions.clear()
  receipts.clear()
  directories.clear()
})

function evolution() {
  return HarnessContract.Evolution.parse({
    protocolVersion: "evolution-trace-v1",
    validatorSHA256: hash("meta-evolution-validator-v1"),
    manifestSchemaSHA256: hash("meta-evolution-manifest-v1"),
    lineAlgorithm: "sha256-exact-line-v1",
    roots: ["evaluator", "harness", "tests"],
    extensions: [".md"],
    exclude: [],
    maxFiles: 16,
    maxFileBytes: 100_000,
    maxTotalBytes: 1_000_000,
    maxSourceLines: 10_000,
    maxChangedLines: 1_000,
  })
}

function confirmation(direction: "maximize" | "minimize") {
  return HarnessContract.Confirmation.parse({
    protocolVersion: "sealed-confirmation-v1",
    optimization: { split: "validation", manifestSHA256: hash("meta-optimization-manifest") },
    claim: {
      taskID: "meta-official-hidden-claim",
      split: "held_out",
      manifestSHA256: hash("meta-hidden-claim-manifest"),
      validatorSHA256: hash("meta-hidden-claim-validator"),
      environmentSHA256: hash("meta-hidden-claim-environment"),
      evaluator: { name: "meta-claim-evaluator", version: "1", source: "benchmark" },
      metric: "score",
      direction,
      target: direction === "maximize" ? 0.8 : 0.5,
    },
    selection: { rule: "terminal-verified-best-v1", subjects: 1 },
    exposure: { policy: "terminal-receipt-only", searchFeedback: false, memoryCapture: false },
    failurePolicy: "fail-closed",
  })
}

function protocol() {
  return HarnessContract.MetaHarness.parse({
    protocolVersion: "meta-harness-v1",
    validatorSHA256: hash("meta-qualifier-v1"),
    archiveSchemaSHA256: hash("meta-archive-v1"),
    traceSchemaSHA256: hash("meta-trace-v1"),
    baseline: { artifactSHA256: hash("baseline-artifact"), manifestSHA256: hash("baseline-manifest") },
    mutable: [{ root: "harness", component: "prompt" }],
    protected: { manifestSHA256: digest(protectedFiles), roots: ["evaluator", "tests"] },
    archive: {
      contents: "full-source-scores-traces",
      query: "filesystem",
      summariesOnly: false,
      hiddenContent: "excluded",
      evaluatorContent: "excluded",
    },
    updater: {
      name: "meta-updater",
      version: "1",
      promptSHA256: hash("updater-prompt"),
      configSHA256: hash("updater-config"),
    },
    judge: {
      name: "meta-adherence-judge",
      version: "1",
      promptSHA256: hash("judge-prompt"),
      configSHA256: hash("judge-config"),
    },
    search: {
      models: [{ id: "model-search", commitment: hash("model-search-weights-config") }],
      tasks: [{ id: "search-activation", commitment: hash("search-task"), activationRequired: true }],
    },
    heldout: {
      models: [{ id: "model-unseen", commitment: hash("model-unseen-weights-config") }],
      tasks: [{ id: "heldout-activation", commitment: hash("heldout-task"), activationRequired: true }],
    },
    thresholds: {
      minSearchGain: 0.1,
      minHeldoutGain: 0.1,
      maxModelRegression: 0.05,
      minActivationRate: 1,
      minRequiredAdherence: 0.9,
      minFinalAdherence: 0.9,
      maxPhaseDrift: 0.1,
      minPredictionPrecision: 1,
      maxRiskRegressions: 0,
      maxContextTokens: 1_000,
      maxMeanContextIncrease: 50,
    },
    promotionRequired: true,
  })
}

function task(
  sessionID: string,
  input: { direction?: "maximize" | "minimize"; metaToken?: string; protocol?: HarnessContract.MetaHarness } = {},
) {
  sessions.add(sessionID)
  const direction = input.direction ?? "maximize"
  const sealed = confirmation(direction)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "meta-harness-v1",
    taskID: `meta-${sessionID}`,
    split: "validation",
    evaluator: { name: "meta-optimization-evaluator", version: "1", source: "benchmark", token: evaluatorToken },
    objective: "Improve a versioned harness and qualify transfer before exposing hidden confirmation",
    profile: "optimize",
    search: "adaptive",
    evolution: evolution(),
    metaHarness: { protocol: input.protocol ?? protocol(), token: input.metaToken ?? metaToken },
    confirmation: { protocol: sealed, token: confirmationToken },
    metric: { name: "score", direction, target: sealed.claim.target },
    model: { provider: "test", name: "model-search" },
    tools: ["read", "bash"],
    skills: [{ name: "evolve-meta-harness", version: "1", sha256: hash("meta-qualifier-v1") }],
    budget: { steps: 20, candidates: 1 },
    seed: 53,
    intervention: "autonomous",
    contamination: { policy: "held-out models and tasks remain qualifier-only", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const checks = (contract: HarnessContract.Info) =>
  HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`meta:${check.id}.json`],
  }))

function snapshot(contract: HarnessContract.Info, content: string) {
  const source = [
    { path: "evaluator/runner.md", content: "frozen evaluator\n" },
    { path: "harness/system.md", content },
    { path: "tests/contract.md", content: "frozen tests\n" },
  ]
  const files = HarnessEvolution.Files.parse([
    ...source.map((file) => ({
      path: file.path,
      sha256: hash(file.content),
      bytes: new TextEncoder().encode(file.content).byteLength,
      lineHashes: file.content.split("\n").flatMap((line) => (line ? [hash(line)] : [])),
    })),
  ])
  return HarnessEvolution.Snapshot.parse({
    artifact: {
      uri: `meta-source://${contract.sessionID}`,
      sha256: HarnessEvolution.manifestSHA256(evolution(), files),
    },
    schemaSHA256: evolution().manifestSchemaSHA256,
    files,
  })
}

async function finish(sessionID: string, direction: "maximize" | "minimize" = "maximize") {
  const contract = await HarnessAdapter.bind(task(sessionID, { direction }))
  const source = snapshot(contract, `refined harness for ${sessionID}\n`)
  const state = await HarnessSearch.initialize({ sessionID })
  const recommendation = HarnessSearch.recommend(state)
  const added = await HarnessSearch.add({
    sessionID,
    recommendationID: recommendation.id,
    parentIDs: recommendation.parentIDs,
    inspirationIDs: recommendation.inspirationIDs,
    branch: "evidence-backed-refinement",
    proposal: "Repair the trace-cited root cause and predict the affected search cell before evaluation",
    artifact: source.artifact,
  })
  const candidate = (await HarnessSearch.read(sessionID)).candidates[added.id]!
  const trace = await HarnessEvolution.record(
    {
      schemaVersion: 1,
      runID: contract.runID,
      sessionID,
      evaluatorToken,
      protocol: evolution(),
      subject: { type: "candidate", id: candidate.id, artifact: candidate.artifact },
      snapshot: source,
      parents: [],
      validator: { name: "trace-evolutionary-candidate", version: 1, scriptSHA256: evolution().validatorSHA256 },
      evidence: ["meta:evolution-trace.json"],
      evaluatedAt: Date.now(),
    },
    contract,
  )
  const score = direction === "maximize" ? 0.9 : 0.4
  const result = await HarnessAdapter.ingest({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID,
    evaluatorToken,
    candidateID: candidate.id,
    evolutionReceiptID: trace.receiptID,
    status: "passed",
    score,
    metrics: { score },
    checks: checks(contract),
    evidence: ["meta:optimization-result.json"],
    evaluatedAt: Date.now() + 1,
  })
  const search = await HarnessSearch.read(sessionID)
  expect(search).toMatchObject({ status: "completed", bestID: candidate.id, stopReason: "objective_met" })
  return { contract, candidate: search.candidates[candidate.id]!, evaluation: result.evaluation, search, source }
}

function phase(followed = 1) {
  return HarnessMeta.PhaseID.options.map((name) => ({
    phase: name,
    followed,
    violatedCommission: 0,
    violatedOmission: 0,
    requiredUnobserved: 0,
    notApplicable: 0,
    insufficientEvidence: 0,
  }))
}

async function submission(
  done: Awaited<ReturnType<typeof finish>>,
  input: { heldoutScore?: number; heldoutOutcome?: "completed" | "failed" | "inconclusive"; stale?: boolean } = {},
) {
  const selection = await HarnessMeta.select(done.contract)
  const protocol = done.contract.metaHarness!
  const trace = (name: string) => ({
    uri: `trace://${done.contract.sessionID}/${name}`,
    sha256: hash(`${done.contract.sessionID}:${name}`),
    schemaSHA256: protocol.traceSchemaSHA256,
    complete: true as const,
    hiddenContent: "excluded" as const,
    evaluatorContent: "excluded" as const,
  })
  const resultSHA256 = digest(done.candidate.result)
  const entries = [
    {
      candidateID: done.candidate.id,
      artifactSHA256: done.candidate.artifact.sha256,
      sourceSHA256: done.source.artifact.sha256,
      state: "evaluated" as const,
      scoresSHA256: digest(done.candidate.result!.metrics),
      resultSHA256,
      evaluationSHA256: HarnessEvaluation.fingerprint(done.evaluation),
      trace: trace("search-candidate"),
    },
  ]
  const archiveBody = {
    uri: `archive://${done.contract.sessionID}`,
    schemaSHA256: protocol.archiveSchemaSHA256,
    indexSHA256: digest(entries),
    contents: "full-source-scores-traces" as const,
    query: "filesystem" as const,
    complete: true as const,
    hiddenContent: "excluded" as const,
    evaluatorContent: "excluded" as const,
    entries,
  }
  const direction = done.contract.benchmark.direction
  const searchScores = direction === "maximize" ? [0.4, 0.9] : [1, 0.4]
  const heldout = input.heldoutScore ?? (direction === "maximize" ? 0.85 : 0.4)
  const heldoutBaseline = direction === "maximize" ? 0.5 : 1
  const outcome = input.heldoutOutcome ?? "completed"
  const cells = [
    {
      split: "search" as const,
      modelID: "model-search",
      modelCommitment: protocol.search.models[0]!.commitment,
      taskID: "search-activation",
      taskCommitment: protocol.search.tasks[0]!.commitment,
      role: "baseline" as const,
      outcome: "completed" as const,
      score: searchScores[0],
      passed: false,
      contextTokens: 100,
      outputSHA256: hash("search-baseline-output"),
      trace: trace("search-baseline"),
      evidence: ["search:baseline.json"],
    },
    {
      split: "search" as const,
      modelID: "model-search",
      modelCommitment: protocol.search.models[0]!.commitment,
      taskID: "search-activation",
      taskCommitment: protocol.search.tasks[0]!.commitment,
      role: "candidate" as const,
      outcome: "completed" as const,
      score: searchScores[1],
      passed: true,
      contextTokens: 120,
      outputSHA256: hash("search-candidate-output"),
      trace: trace("search-candidate-cell"),
      evidence: ["search:candidate.json"],
      loaded: true,
      phases: phase(),
    },
    {
      split: "held_out" as const,
      modelID: "model-unseen",
      modelCommitment: protocol.heldout.models[0]!.commitment,
      taskID: "heldout-activation",
      taskCommitment: protocol.heldout.tasks[0]!.commitment,
      role: "baseline" as const,
      outcome: "completed" as const,
      score: heldoutBaseline,
      passed: false,
      contextTokens: 110,
      outputSHA256: hash("heldout-baseline-output"),
      trace: trace("heldout-baseline"),
      evidence: ["heldout:baseline.json"],
    },
    {
      split: "held_out" as const,
      modelID: "model-unseen",
      modelCommitment: protocol.heldout.models[0]!.commitment,
      taskID: "heldout-activation",
      taskCommitment: protocol.heldout.tasks[0]!.commitment,
      role: "candidate" as const,
      outcome,
      ...(outcome === "completed" ? { score: heldout, passed: true } : {}),
      contextTokens: 130,
      outputSHA256: hash(`heldout-candidate-output:${outcome}:${heldout}`),
      trace: trace("heldout-candidate"),
      evidence: ["heldout:candidate.json"],
      loaded: true,
      phases: outcome === "completed" ? phase() : phase().slice(0, 2),
    },
  ].toSorted((left, right) =>
    `${left.split}\0${left.modelID}\0${left.taskID}\0${left.role}`.localeCompare(
      `${right.split}\0${right.modelID}\0${right.taskID}\0${right.role}`,
    ),
  )
  return HarnessMeta.Submit.parse({
    schemaVersion: 1,
    sessionID: done.contract.sessionID,
    metaToken,
    selectionID: selection.selectionID,
    candidateArtifactSHA256: selection.candidateArtifact.sha256,
    candidateManifestSHA256: digest(done.source.files.map((file) => ({ path: file.path, sha256: file.sha256 }))),
    protectedManifestSHA256: protocol.protected.manifestSHA256,
    validatorSHA256: protocol.validatorSHA256,
    archive: { ...archiveBody, sha256: digest(archiveBody) },
    refinements: [
      {
        revision: 1,
        scope: "session",
        parentSnapshotSHA256: input.stale ? hash("stale-parent") : protocol.baseline.artifactSHA256,
        snapshotSHA256: selection.candidateArtifact.sha256,
        trigger: "Archived search trace exposed a missing task-specific instruction",
        diagnosis: { kind: "implementation", rationale: "The capability existed but was not activated in context" },
        rootCause: "The base prompt omitted a required verification trigger",
        expectedOutcome: "The search failure flips without regressing the protected passing task",
        changes: [
          {
            action: "update",
            component: "prompt",
            path: "harness/system.md",
            beforeSHA256: hash("baseline-system"),
            afterSHA256: done.source.files.find((file) => file.path === "harness/system.md")!.sha256,
            reason: "Add the trace-supported verification trigger",
          },
        ],
        evidence: [
          {
            candidateID: done.candidate.id,
            traceSHA256: entries[0]!.trace.sha256,
            messageIndex: 3,
            excerptSHA256: hash("trace-excerpt"),
          },
        ],
        predictions: [{ modelID: "model-search", taskID: "search-activation", expected: "fail_to_pass" }],
      },
    ],
    cells,
    evaluatedAt: Math.max(Date.now(), selection.selectedAt),
  })
}

describe("continual meta-harness qualification", () => {
  test("freezes disjoint models, tasks, identities, roots, activation coverage, and capabilities", () => {
    const base = protocol()
    expect(() =>
      HarnessContract.MetaHarness.parse({
        ...base,
        heldout: { ...base.heldout, models: [{ id: "model-search", commitment: hash("other-model") }] },
      }),
    ).toThrow("unseen in search")
    expect(() =>
      HarnessContract.MetaHarness.parse({
        ...base,
        heldout: { ...base.heldout, tasks: [{ ...base.search.tasks[0], id: "heldout-copy" }] },
      }),
    ).toThrow("unseen in search")
    expect(() =>
      HarnessContract.MetaHarness.parse({
        ...base,
        search: { ...base.search, tasks: base.search.tasks.map((item) => ({ ...item, activationRequired: false })) },
      }),
    ).toThrow("activation-required")
    expect(() => HarnessContract.MetaHarness.parse({ ...base, judge: base.updater })).toThrow("identities must differ")
    expect(() =>
      HarnessContract.MetaHarness.parse({
        ...base,
        protected: { ...base.protected, roots: ["harness/tests"] },
      }),
    ).toThrow("cannot overlap")
    expect(() => task("meta-capability-alias", { metaToken: evaluatorToken })).toThrow("capabilities must differ")
  })

  test("qualifies a direction-aware cross-model improvement and opens sealed confirmation", async () => {
    const done = await finish("meta-passing")
    await expect(HarnessConfirmation.select(done.contract)).rejects.toThrow("qualification is recorded")
    const receipt = await HarnessMeta.record(await submission(done), done.contract)
    receipts.add(receipt.receiptID)
    expect(receipt).toMatchObject({
      status: "passed",
      diagnostics: {
        updaterGain: 0.5,
        beneficiaryGain: 0.35,
        worstHeldoutModelGain: 0.35,
        activationRate: 1,
        predictionPrecision: 1,
        riskRegressions: 0,
      },
    })
    expect((await HarnessMeta.assert(done.contract, receipt.receiptID)).receiptID).toBe(receipt.receiptID)
    expect((await HarnessConfirmation.select(done.contract)).candidateID).toBe(done.candidate.id)
    const report = HarnessReport.compile({
      contract: done.contract,
      evaluations: [done.evaluation],
      search: done.search,
      meta: receipt,
    })
    expect(report.quality).toMatchObject({ provisional: true, metaReceiptID: receipt.receiptID })
    expect(report.metaHarness).toMatchObject({ status: "passed", selectionID: receipt.selection.selectionID })
  })

  test("handles minimize metrics without inverting beneficiary evidence", async () => {
    const done = await finish("meta-minimize", "minimize")
    const receipt = await HarnessMeta.record(await submission(done), done.contract)
    receipts.add(receipt.receiptID)
    expect(receipt.status).toBe("passed")
    expect(receipt.diagnostics).toMatchObject({ updaterGain: 0.6, beneficiaryGain: 0.6 })
  })

  test("rejects stale lineage, protected mutations, incomplete archives, and content-hash substitution", async () => {
    const done = await finish("meta-adversarial")
    await expect(HarnessMeta.record(await submission(done, { stale: true }), done.contract)).rejects.toThrow(
      "lineage is stale",
    )
    const base = await submission(done)
    await expect(
      HarnessMeta.record(
        {
          ...base,
          refinements: [
            {
              ...base.refinements[0]!,
              changes: [{ ...base.refinements[0]!.changes[0]!, path: "tests/hidden.ts" }],
            },
          ],
        },
        done.contract,
      ),
    ).rejects.toThrow("outside its declared mutable component")
    expect(() => HarnessMeta.Submit.parse({ ...base, archive: { ...base.archive, entries: [] } })).toThrow()
    expect(() => HarnessMeta.Submit.parse({ ...base, archive: { ...base.archive, sha256: hash("forged") } })).toThrow(
      "content hash",
    )
    await expect(
      HarnessMeta.record({ ...base, candidateManifestSHA256: hash("forged-candidate-manifest") }, done.contract),
    ).rejects.toThrow("exact source snapshot")
  })

  test("fails closed on held-out regression and forbids qualification retries", async () => {
    const done = await finish("meta-regression")
    const receipt = await HarnessMeta.record(await submission(done, { heldoutScore: 0.2 }), done.contract)
    receipts.add(receipt.receiptID)
    expect(receipt.status).toBe("failed")
    expect(receipt.failures).toContain("beneficiary-gain:-0.3")
    await expect(HarnessConfirmation.select(done.contract)).rejects.toThrow("failed meta-harness qualification")
    await expect(HarnessMeta.record(await submission(done), done.contract)).rejects.toThrow("retries are forbidden")
  })

  test("preserves incomplete evidence as inconclusive and keeps the promotion firewall closed", async () => {
    const done = await finish("meta-inconclusive")
    const receipt = await HarnessMeta.record(await submission(done, { heldoutOutcome: "inconclusive" }), done.contract)
    receipts.add(receipt.receiptID)
    expect(receipt.status).toBe("inconclusive")
    expect(receipt.failures).toContain("beneficiary-gain:unavailable")
    await expect(HarnessConfirmation.select(done.contract)).rejects.toThrow("inconclusive meta-harness qualification")
  })

  test("exposes selections and receipts only through the qualifier capability", async () => {
    const done = await finish("meta-route")
    const app = HarnessRoutes()
    const denied = await app.request("/meta/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: done.contract.sessionID, metaToken: evaluatorToken }),
    })
    expect(denied.status).not.toBe(200)
    const selected = await app.request("/meta/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: done.contract.sessionID, metaToken }),
    })
    expect(selected.status).toBe(200)
    const recorded = await app.request("/meta/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await submission(done)),
    })
    expect(recorded.status).toBe(200)
    const receipt = (await recorded.json()) as HarnessMeta.Receipt
    receipts.add(receipt.receiptID)
    const read = await app.request(`/meta/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: done.contract.sessionID, metaToken }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "passed" })
  })

  test("builds a token-free qualification body with the native skill utility", async () => {
    const done = await finish("meta-skill-builder")
    const input = await submission(done)
    const directory = await fs.mkdtemp(path.join(Global.Path.data, "meta-skill-"))
    directories.add(directory)
    const files = {
      protocol: path.join(directory, "protocol.json"),
      selection: path.join(directory, "selection.json"),
      archive: path.join(directory, "archive.json"),
      refinements: path.join(directory, "refinements.json"),
      cells: path.join(directory, "cells.json"),
      output: path.join(directory, "submission.json"),
    }
    await Promise.all([
      Bun.write(files.protocol, JSON.stringify(done.contract.metaHarness)),
      Bun.write(files.selection, JSON.stringify(await HarnessMeta.select(done.contract))),
      Bun.write(files.archive, JSON.stringify({ uri: input.archive.uri, entries: input.archive.entries })),
      Bun.write(files.refinements, JSON.stringify(input.refinements)),
      Bun.write(files.cells, JSON.stringify(input.cells)),
    ])
    const process = Bun.spawn(
      [
        "bun",
        "skills/research/evolve-meta-harness/scripts/build_submission.ts",
        "--protocol",
        files.protocol,
        "--selection",
        files.selection,
        "--archive",
        files.archive,
        "--refinements",
        files.refinements,
        "--cells",
        files.cells,
        "--candidate-manifest",
        input.candidateManifestSHA256,
        "--output",
        files.output,
      ],
      { cwd: path.join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    expect(await process.exited).toBe(0)
    const body = JSON.parse(await Bun.file(files.output).text())
    expect(body.metaToken).toBeUndefined()
    expect(body.archive).toEqual(input.archive)
    expect(HarnessMeta.Submit.parse({ ...body, metaToken })).toMatchObject({ selectionID: input.selectionID })
  })
})
