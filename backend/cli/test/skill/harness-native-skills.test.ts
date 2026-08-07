import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessAutonomy } from "../../src/session/harness/autonomy"
import { HarnessBlueprint } from "../../src/session/harness/blueprint"
import { HarnessEvolution } from "../../src/session/harness/evolution"
import { HarnessFormal } from "../../src/session/harness/formal"

const skills = path.resolve(import.meta.dir, "../../skills")

const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const canon = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canon(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
const digest = (value: unknown) => hash(canon(value))
const fileHash = async (file: string) => hash(new Uint8Array(await Bun.file(file).arrayBuffer()))

async function run(script: string, args: string[]) {
  const process = Bun.spawn(["python", path.join(skills, script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function bun(script: string, args: string[]) {
  const process = Bun.spawn(["bun", path.join(skills, script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("active-failure-audit builds an opaque committed probe manifest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-audit-"))
  const source = path.join(dir, "private.jsonl")
  const output = path.join(dir, "manifest.json")
  await Bun.write(
    source,
    [
      JSON.stringify({
        id: "hard-1",
        hidden: { prompt: "PRIVATE_ALPHA", target: "answer-a" },
        features: [0.1, 0.9],
        stratum: "rare",
      }),
      JSON.stringify({
        id: "hard-2",
        hidden: { prompt: "PRIVATE_BETA", target: "answer-b" },
        features: [0.8, 0.2],
        stratum: "common",
        weight: 2,
        priorLoss: 0.7,
      }),
    ].join("\n"),
  )

  try {
    const result = await run("research/active-failure-audit/scripts/build_probe_manifest.py", [source, output])
    expect(result.code).toBe(0)
    const manifest = await Bun.file(output).text()
    expect(manifest).not.toContain("PRIVATE_ALPHA")
    expect(manifest).not.toContain("PRIVATE_BETA")
    const parsed = JSON.parse(manifest)
    expect(parsed.probes).toHaveLength(2)
    expect(parsed.probes[0].commitment).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.manifestSHA256).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("active-failure-audit rejects duplicate hidden probes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-audit-"))
  const source = path.join(dir, "private.jsonl")
  const output = path.join(dir, "manifest.json")
  await Bun.write(
    source,
    [
      JSON.stringify({ id: "a", hidden: { value: 1 }, features: [0], stratum: "x" }),
      JSON.stringify({ id: "b", hidden: { value: 1 }, features: [1], stratum: "y" }),
    ].join("\n"),
  )

  try {
    const result = await run("research/active-failure-audit/scripts/build_probe_manifest.py", [source, output])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("hidden probe commitments must be unique")
    expect(await Bun.file(output).exists()).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("verify-benchmark-integrity derives observable violations from an evaluator-owned trace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-integrity-"))
  const trace = path.join(dir, "trace.jsonl")
  const contract = path.join(dir, "contract.json")
  const subject = path.join(dir, "subject.json")
  const model = path.join(dir, "model.json")
  const audits = path.join(dir, "audits.json")
  const output = path.join(dir, "submission.json")
  const report = path.join(dir, "report.json")
  const canaries = hash("canaries")
  const commitments = await run("research/verify-benchmark-integrity/scripts/verify_integrity.py", ["commitments"])
  expect(commitments.code).toBe(0)
  const pins = JSON.parse(commitments.stdout)
  const kinds = ["test_item_contamination", "external_model_use", "benchmark_lookup"]
  const identities = kinds.map((kind) => ({
    kind,
    name: `${kind}-auditor`,
    version: "1",
    promptSHA256: hash(`${kind}-prompt`),
  }))
  await Promise.all([
    Bun.write(
      contract,
      JSON.stringify({
        protocolVersion: "benchmark-integrity-v1",
        validatorSHA256: pins.validatorSHA256,
        traceSchemaSHA256: pins.traceSchemaSHA256,
        minEvents: 4,
        minCoverage: 0.9,
        assignedModel: {
          name: "assigned-model",
          baseArtifactSHA256: hash("base"),
          configSHA256: hash("config"),
        },
        forbiddenModelArtifacts: [hash("forbidden")],
        policy: {
          testItemDerivation: "forbidden",
          unapprovedExternalModels: "forbidden",
          benchmarkLookup: "forbidden",
        },
        auditors: identities,
        hiddenCanaryManifestSHA256: canaries,
        minHiddenCanaries: 2,
      }),
    ),
    Bun.write(
      trace,
      [
        { seq: 0, at: 1_000, kind: "command" },
        { seq: 1, at: 1_001, kind: "model_call", approved: true },
        { seq: 2, at: 1_002, kind: "model_call", approved: false },
        { seq: 3, at: 1_003, kind: "benchmark_lookup" },
        { seq: 4, at: 1_004, kind: "hidden_canary", manifestSHA256: canaries, canaryID: "a", violation: false },
        { seq: 5, at: 1_005, kind: "hidden_canary", manifestSHA256: canaries, canaryID: "b", violation: true },
        { seq: 6, at: 1_006, kind: "trace_gap", dropped: 1 },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    ),
    Bun.write(
      subject,
      JSON.stringify({ type: "run", id: "run-1", artifact: { uri: "artifact:output", sha256: hash("output") } }),
    ),
    Bun.write(
      model,
      JSON.stringify({
        name: "assigned-model",
        baseArtifactSHA256: hash("base"),
        configSHA256: hash("config"),
        outputArtifactSHA256: hash("fine-tuned"),
        lineageVerified: true,
      }),
    ),
    Bun.write(
      audits,
      JSON.stringify(
        identities.map((identity) => ({
          ...identity,
          decision: "clean",
          confidence: 0.99,
          evidence: [`artifact:${identity.kind}.json`],
        })),
      ),
    ),
  ])

  try {
    const result = await run("research/verify-benchmark-integrity/scripts/verify_integrity.py", [
      "build",
      "--contract",
      contract,
      "--trace",
      trace,
      "--subject",
      subject,
      "--model",
      model,
      "--audits",
      audits,
      "--run-id",
      "run-1",
      "--session-id",
      "session-1",
      "--evaluated-at",
      "1100",
      "--output",
      output,
      "--report",
      report,
    ])
    expect(result.code).toBe(0)
    const submission = JSON.parse(await Bun.file(output).text())
    expect(submission.evaluatorToken).toBeUndefined()
    expect(submission.trace).toMatchObject({ events: 7, dropped: 1, schemaSHA256: pins.traceSchemaSHA256 })
    expect(submission.activity).toMatchObject({
      unapprovedExternalModelCalls: 1,
      benchmarkLookupEvents: 1,
      hiddenCanariesTested: 2,
      hiddenCanaryViolations: 1,
    })
    expect(JSON.parse(await Bun.file(report).text()).traceCoverage).toBe(0.875)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("verify-benchmark-integrity rejects a non-contiguous trace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-integrity-gap-"))
  const trace = path.join(dir, "trace.jsonl")
  await Bun.write(
    trace,
    [
      { seq: 0, at: 1, kind: "command" },
      { seq: 2, at: 2, kind: "command" },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n"),
  )
  try {
    const result = await run("research/verify-benchmark-integrity/scripts/verify_integrity.py", [
      "check-trace",
      "--trace",
      trace,
      "--canary-manifest",
      hash("canaries"),
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("trace sequence must be contiguous")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("trace-evolutionary-candidate captures exact snapshots and deterministic parent deltas", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-evolution-"))
  const parentRoot = path.join(dir, "parent")
  const childRoot = path.join(dir, "child")
  const parentArtifacts = path.join(dir, "parent-artifacts")
  const childArtifacts = path.join(dir, "child-artifacts")
  const contract = path.join(dir, "contract.json")
  const parentSubject = path.join(dir, "parent-subject.json")
  const childSubject = path.join(dir, "child-subject.json")
  const parentOutput = path.join(dir, "parent-submission.json")
  const childOutput = path.join(dir, "child-submission.json")
  const parentSpec = path.join(dir, "parent.json")
  const report = path.join(dir, "child-report.json")
  await Promise.all([
    fs.mkdir(path.join(parentRoot, "src"), { recursive: true }),
    fs.mkdir(path.join(childRoot, "src"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(path.join(parentRoot, "src", "main.py"), "alpha\nold\n"),
    Bun.write(path.join(childRoot, "src", "main.py"), "alpha\nnew\n"),
  ])
  const commitments = await run("research/trace-evolutionary-candidate/scripts/trace_candidate.py", ["commitments"])
  expect(commitments.code).toBe(0)
  const pins = JSON.parse(commitments.stdout)
  const protocol = HarnessContract.Evolution.parse({
    protocolVersion: "evolution-trace-v1",
    validatorSHA256: pins.validatorSHA256,
    manifestSchemaSHA256: pins.manifestSchemaSHA256,
    lineAlgorithm: "sha256-exact-line-v1",
    roots: ["src"],
    extensions: [".py"],
    exclude: [],
    maxFiles: 10,
    maxFileBytes: 10_000,
    maxTotalBytes: 100_000,
    maxSourceLines: 1_000,
    maxChangedLines: 100,
  })
  await Promise.all([
    Bun.write(contract, JSON.stringify(protocol)),
    Bun.write(
      parentSubject,
      JSON.stringify({
        type: "candidate",
        id: hash("parent-id"),
        artifact: { uri: "artifact:parent.tar", sha256: hash("parent-artifact") },
      }),
    ),
    Bun.write(
      childSubject,
      JSON.stringify({
        type: "candidate",
        id: hash("child-id"),
        artifact: { uri: "artifact:child.tar", sha256: hash("child-artifact") },
      }),
    ),
  ])

  try {
    const root = await run("research/trace-evolutionary-candidate/scripts/trace_candidate.py", [
      "build",
      "--contract",
      contract,
      "--subject",
      parentSubject,
      "--candidate-root",
      parentRoot,
      "--artifact-dir",
      parentArtifacts,
      "--run-id",
      "run-1",
      "--session-id",
      "session-1",
      "--evaluated-at",
      "1000",
      "--output",
      parentOutput,
    ])
    expect(root.code).toBe(0)
    const parent = JSON.parse(await Bun.file(parentOutput).text())
    expect(parent.parents).toEqual([])
    expect(parent.snapshot.files).toEqual([
      expect.objectContaining({
        path: "src/main.py",
        lineHashes: [hash("alpha"), hash("old")],
      }),
    ])
    expect(parent.snapshot.artifact.sha256).toBe(await fileHash(parent.snapshot.artifact.uri))
    expect(parent.snapshot.artifact.sha256).toBe(HarnessEvolution.manifestSHA256(protocol, parent.snapshot.files))
    await Bun.write(
      parentSpec,
      JSON.stringify({
        id: parent.subject.id,
        artifact: parent.subject.artifact,
        receiptID: hash("parent-receipt"),
        snapshot: parent.snapshot.artifact,
        root: parentRoot,
      }),
    )
    const child = await run("research/trace-evolutionary-candidate/scripts/trace_candidate.py", [
      "build",
      "--contract",
      contract,
      "--subject",
      childSubject,
      "--candidate-root",
      childRoot,
      "--parent",
      parentSpec,
      "--artifact-dir",
      childArtifacts,
      "--run-id",
      "run-1",
      "--session-id",
      "session-1",
      "--evaluated-at",
      "1100",
      "--output",
      childOutput,
      "--report",
      report,
    ])
    expect(child.code).toBe(0)
    const submission = JSON.parse(await Bun.file(childOutput).text())
    expect(submission.evaluatorToken).toBeUndefined()
    expect(submission.parents).toHaveLength(1)
    const delta = JSON.parse(await Bun.file(submission.parents[0].delta.uri).text())
    expect(delta).toMatchObject({
      parent: { id: parent.subject.id, snapshotSHA256: parent.snapshot.artifact.sha256 },
      candidate: { id: submission.subject.id, snapshotSHA256: submission.snapshot.artifact.sha256 },
      addedLineHashes: [hash("new")],
      deletedLineHashes: [hash("old")],
    })
    expect(submission.parents[0].delta.sha256).toBe(digest(delta))
    expect(submission.parents[0].delta.sha256).toBe(
      HarnessEvolution.deltaSHA256({
        subject: submission.subject,
        snapshot: submission.snapshot,
        parent: { subject: parent.subject, snapshot: parent.snapshot },
      }),
    )
    expect(JSON.parse(await Bun.file(report).text())).toMatchObject({
      files: 1,
      sourceLines: 2,
      parents: [{ filesChanged: 1, addedLines: 1, deletedLines: 1 }],
    })

    await Bun.write(path.join(parentRoot, "src", "main.py"), "substituted\n")
    const rejected = await run("research/trace-evolutionary-candidate/scripts/trace_candidate.py", [
      "build",
      "--contract",
      contract,
      "--subject",
      childSubject,
      "--candidate-root",
      childRoot,
      "--parent",
      parentSpec,
      "--artifact-dir",
      path.join(dir, "rejected-artifacts"),
      "--run-id",
      "run-1",
      "--session-id",
      "session-1",
    ])
    expect(rejected.code).toBe(2)
    expect(rejected.stderr).toContain("does not match its immutable snapshot")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("operate-adaptive-search rejects inconsistent controller decisions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-adaptive-lease-"))
  const script = "research/operate-adaptive-search/scripts/validate_lease.py"
  const source = path.join(dir, "lease.json")
  const lease = {
    id: hash("lease"),
    revision: 7,
    strategy: "exploit",
    mode: "diff",
    parentIDs: [hash("parent")],
    inspirationIDs: [],
    targetIsland: 1,
    contextIDs: [hash("parent")],
    reasons: ["adaptive-exploitation"],
    control: {
      protocolVersion: "adaptive-search-v1",
      policySHA256: hash(JSON.stringify(HarnessContract.adaptiveSearch)),
      eventCount: 6,
      stalled: 0,
      selectedIsland: 1,
      targetIsland: 1,
      visits: 3,
      accumulatedImprovement: 0.04,
      rewardMean: 0.02,
      intensity: 0.3,
      draw: 0.8,
      explore: false,
      globalStagnation: false,
    },
  }
  try {
    await Bun.write(source, JSON.stringify(lease))
    const valid = await run(script, [source])
    expect(valid.code).toBe(0)
    expect(JSON.parse(valid.stdout)).toMatchObject({
      valid: true,
      strategy: "exploit",
      targetIsland: 1,
      eventCount: 6,
      explore: false,
    })
    await Bun.write(source, JSON.stringify({ ...lease, control: { ...lease.control, explore: true } }))
    const rejected = await run(script, [source])
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain("deterministic intensity draw")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("run-verifier-routed-research enforces clean restart context isolation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-verifier-unit-"))
  const script = "research/run-verifier-routed-research/scripts/validate_unit.py"
  const source = path.join(dir, "work.json")
  const review = (id: string) => ({ id: hash(id), role: "verification", status: "completed" })
  const work = {
    id: hash("clean-restart"),
    status: "pending",
    role: "generation",
    label: "clean-restart-2",
    prompt: 'role="generation" topology="verifier_loop" return one complete candidate artifact',
    context: [review("review-a"), review("review-b")],
    allocation: { steps: 1, tokens: 1000, costUSD: 0.01, wallTimeMs: 1000 },
  }
  try {
    await Bun.write(source, JSON.stringify(work))
    const valid = await run(script, [source])
    expect(valid.code).toBe(0)
    expect(JSON.parse(valid.stdout)).toMatchObject({
      valid: true,
      role: "generation",
      label: "clean-restart-2",
    })

    await Bun.write(
      source,
      JSON.stringify({
        ...work,
        context: [{ id: hash("rejected-candidate"), role: "generation", status: "completed" }, ...work.context],
      }),
    )
    const rejected = await run(script, [source])
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain("clean restart may receive verifier summaries only")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("audit-scientific-meaning derives status without persisting review capabilities", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-semantic-audit-"))
  const script = "research/audit-scientific-meaning/scripts/validate_submission.py"
  const contractFile = path.join(dir, "contract.json")
  const submissionFile = path.join(dir, "submission.json")
  const objective = "Resolve the intended open problem without a vacuous interpretation"
  const scope = {
    objectiveSHA256: hash(objective),
    criteria: [{ id: "target", requirement: "Address the intended target." }],
    forbiddenShortcuts: [{ id: "vacuity", description: "Do not use a trivial interpretation." }],
    literature: { cutoff: "2026-08-01", corpusSHA256: hash("semantic-corpus") },
    noveltyFloor: "minor",
  }
  const contract = {
    sessionID: "semantic-session",
    runID: "semantic-run",
    objective,
    semanticAudit: {
      protocolVersion: "semantic-audit-v1",
      reviewer: { name: "expert-panel", version: "1", source: "external" },
      scope,
      minReviewers: 2,
      minConfidence: 0.8,
    },
  }
  const review = (actor: string, sessionID: string) => ({
    actor,
    sessionID,
    correctness: "passed",
    alignment: "intended",
    novelty: "minor",
    vacuous: false,
    confidence: 0.9,
    criteria: [{ id: "target", status: "passed", evidence: [`artifact:${actor}-target`] }],
    shortcuts: [{ id: "vacuity", observed: false, evidence: [`artifact:${actor}-vacuity`] }],
    literatureRefs: [`literature:${actor}`],
    evidence: [`artifact:${actor}-review`],
    summary: "Independent substantive review",
    reviewedAt: Date.now(),
  })
  const submission = {
    sessionID: contract.sessionID,
    subject: { type: "run", id: contract.runID },
    reviews: [review("reviewer-a", "review-session-a"), review("reviewer-b", "review-session-b")],
  }
  try {
    await Promise.all([
      Bun.write(contractFile, JSON.stringify(contract)),
      Bun.write(submissionFile, JSON.stringify(submission)),
    ])
    const valid = await run(script, [contractFile, submissionFile])
    expect(valid.code).toBe(0)
    expect(JSON.parse(valid.stdout)).toMatchObject({
      valid: true,
      derivedStatus: "meaningful",
      reviewers: 2,
      subject: submission.subject,
    })

    await Bun.write(submissionFile, JSON.stringify({ ...submission, reviewerToken: "must-not-touch-disk" }))
    const rejected = await run(script, [contractFile, submissionFile])
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain("token-free on disk")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("run-replicated-evaluation preflights the exact frozen independent-unit grid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-replicated-evaluation-"))
  const script = "research/run-replicated-evaluation/scripts/preflight.py"
  const contractFile = path.join(dir, "contract.json")
  const observationsFile = path.join(dir, "observations.json")
  const contract = {
    sessionID: "replicated-session",
    runID: "replicated-run",
    replication: {
      protocolVersion: "replicated-evaluation-v1",
      environmentSHA256: hash("locked-environment"),
      sampling: {
        strata: [{ id: "task-a", commitmentSHA256: hash("task-a") }],
        clusters: ["seed-a", "seed-b", "seed-c", "seed-d", "seed-e"].map((id) => ({
          id,
          commitmentSHA256: hash(id),
        })),
      },
      estimator: "iqm",
    },
  }
  const observations = contract.replication.sampling.clusters.map((cluster, index) => ({
    stratumID: "task-a",
    clusterID: cluster.id,
    stratumSHA256: contract.replication.sampling.strata[0]!.commitmentSHA256,
    clusterSHA256: cluster.commitmentSHA256,
    status: "passed",
    score: index + 1,
    outputSHA256: hash(`${cluster.id}:output`),
    environmentSHA256: hash("locked-environment"),
    evidence: [`artifact:${cluster.id}.json`],
    evaluatedAt: Date.now(),
  }))
  try {
    await Promise.all([
      Bun.write(contractFile, JSON.stringify(contract)),
      Bun.write(
        observationsFile,
        JSON.stringify({
          sessionID: contract.sessionID,
          subject: { type: "run", id: contract.runID },
          observations,
        }),
      ),
    ])
    const valid = await run(script, [contractFile, observationsFile])
    expect(valid.code).toBe(0)
    expect(JSON.parse(valid.stdout)).toEqual({
      valid: true,
      units: 5,
      strata: 1,
      clusters: 5,
      estimator: "iqm",
      statuses: { passed: 5, failed: 0, inconclusive: 0 },
    })

    await Bun.write(observationsFile, JSON.stringify({ observations: observations.slice(1) }))
    const missing = await run(script, [contractFile, observationsFile])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("frozen grid mismatch")

    await Bun.write(observationsFile, JSON.stringify({ evaluatorToken: "must-not-touch-disk", observations }))
    const token = await run(script, [contractFile, observationsFile])
    expect(token.code).toBe(1)
    expect(token.stderr).toContain("token-free")

    await Bun.write(
      observationsFile,
      JSON.stringify({
        observations: [
          { ...observations[0], environmentSHA256: hash("drifted-environment") },
          ...observations.slice(1),
        ],
      }),
    )
    const drift = await run(script, [contractFile, observationsFile])
    expect(drift.code).toBe(1)
    expect(drift.stderr).toContain("frozen environment")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("run-sealed-confirmation preflights one token-free terminal claim result", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-sealed-confirmation-"))
  const script = "research/run-sealed-confirmation/scripts/preflight.py"
  const protocolFile = path.join(dir, "protocol.json")
  const selectionFile = path.join(dir, "selection.json")
  const resultFile = path.join(dir, "result.json")
  const outputFile = path.join(dir, "payload.json")
  const protocol = {
    protocolVersion: "sealed-confirmation-v1",
    optimization: { split: "validation", manifestSHA256: hash("optimization-manifest") },
    claim: {
      taskID: "official-hidden",
      split: "held_out",
      manifestSHA256: hash("claim-manifest"),
      validatorSHA256: hash("claim-validator"),
      environmentSHA256: hash("claim-environment"),
      evaluator: { name: "claim-evaluator", version: "2", source: "benchmark" },
      metric: "score",
      direction: "maximize",
      target: 0.8,
    },
    selection: { rule: "terminal-verified-best-v1", subjects: 1 },
    exposure: { policy: "terminal-receipt-only", searchFeedback: false, memoryCapture: false },
    failurePolicy: "fail-closed",
  }
  const stable = {
    schemaVersion: 1,
    protocolVersion: "terminal-verified-best-selection-v1",
    contractSHA256: hash("contract"),
    protocolSHA256: hash(JSON.stringify(protocol)),
    sourceSessionID: "confirmation-session",
    runID: "confirmation-run",
    searchRevision: 4,
    stopReason: "objective_met",
    candidateID: hash("candidate-id"),
    candidateArtifact: { uri: "candidate://winner", sha256: hash("candidate-artifact") },
    candidateCreatedAt: 100,
    optimizationResultSHA256: hash("optimization-result"),
    optimizationEvaluationSHA256: hash("optimization-evaluation"),
    selectedAt: 200,
  }
  const selection = { ...stable, selectionID: hash(JSON.stringify(stable)) }
  const result = {
    candidateSHA256: selection.candidateArtifact.sha256,
    manifestSHA256: protocol.claim.manifestSHA256,
    validatorSHA256: protocol.claim.validatorSHA256,
    environmentSHA256: protocol.claim.environmentSHA256,
    outcome: "completed",
    score: 0.85,
    metrics: { score: 0.85 },
    checks: [{ id: "official-gate", status: "passed", blocking: true, evidence: ["claim:gate.json"] }],
    evidence: ["claim:result.json"],
    outputSHA256: hash("claim-output"),
    evaluatedAt: 201,
  }
  try {
    await Promise.all([
      Bun.write(protocolFile, JSON.stringify(protocol)),
      Bun.write(selectionFile, JSON.stringify(selection)),
      Bun.write(resultFile, JSON.stringify(result)),
    ])
    const valid = await run(script, [
      "--protocol",
      protocolFile,
      "--selection",
      selectionFile,
      "--result",
      resultFile,
      "--out",
      outputFile,
    ])
    expect(valid.code).toBe(0)
    expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, tokenFree: true, derivedTargetReached: true })
    expect(JSON.parse(await Bun.file(outputFile).text())).toEqual({
      schemaVersion: 1,
      sessionID: selection.sourceSessionID,
      ...result,
    })

    await Bun.write(resultFile, JSON.stringify({ ...result, candidateSHA256: hash("alternate") }))
    const changed = await run(script, [
      "--protocol",
      protocolFile,
      "--selection",
      selectionFile,
      "--result",
      resultFile,
      "--out",
      outputFile,
    ])
    expect(changed.code).toBe(1)
    expect(changed.stderr).toContain("candidate substitution")

    await Bun.write(resultFile, JSON.stringify({ ...result, confirmationToken: "must-not-touch-disk" }))
    const token = await run(script, [
      "--protocol",
      protocolFile,
      "--selection",
      selectionFile,
      "--result",
      resultFile,
      "--out",
      outputFile,
    ])
    expect(token.code).toBe(1)
    expect(token.stderr).toContain("secret field")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("design-replay-interventions freezes exact one-difference evaluator pairs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-interventions-"))
  const script = "research/design-replay-interventions/scripts/design_interventions.py"
  const contract = path.join(dir, "contract.json")
  const spec = path.join(dir, "spec.json")
  const output = path.join(dir, "initialize.json")
  const report = path.join(dir, "targets.json")
  const commitments = await run(script, ["commitments"])
  expect(commitments.code).toBe(0)
  const validatorSHA256 = JSON.parse(commitments.stdout).validatorSHA256
  const artifact = (name: string) => ({ uri: `artifact:${name}`, sha256: hash(name) })
  const subject = { type: "candidate", id: hash("winner"), artifact: artifact("winner") }
  const condition = (seed: number) => ({
    seed,
    model: { provider: "test", name: "primary", version: "1" },
    context: artifact("context"),
    evaluator: { name: "official", version: "1", source: "benchmark" },
    split: { name: "held_out", manifest: artifact("split") },
    environment: artifact("environment"),
    budget: artifact("budget"),
  })
  const pairs = [0, 1, 2].flatMap((index) => {
    const base = condition(index)
    const winner = { artifact: subject.artifact, condition: base }
    return [
      {
        family: "model_transfer",
        index,
        control: winner,
        arm: {
          artifact: subject.artifact,
          condition: { ...base, model: { provider: "test", name: "transfer", version: "2" } },
        },
        change: artifact(`model-${index}`),
      },
      { family: "replay", index, control: winner, arm: winner, change: artifact(`replay-${index}`) },
      {
        family: "retune",
        index,
        control: { artifact: artifact(`retuned-${index}`), condition: base },
        arm: winner,
        change: artifact(`retune-${index}`),
      },
    ]
  })
  await Promise.all([
    Bun.write(
      contract,
      JSON.stringify({
        protocolVersion: "intervention-study-v1",
        validatorSHA256,
        requiredForPromotion: true,
        minPairs: 3,
        maxPairs: 4,
        maxTotalPairs: 12,
        confidence: 0.95,
        required: ["model_transfer", "replay", "retune"],
        rules: [
          { family: "model_transfer", mode: "max_regression", threshold: 0.05 },
          { family: "replay", mode: "max_absolute_effect", threshold: 0.01 },
          { family: "retune", mode: "min_effect", threshold: 0.1 },
        ],
      }),
    ),
    Bun.write(
      spec,
      JSON.stringify({
        schemaVersion: 1,
        runID: "run-1",
        sessionID: "session-1",
        subject,
        evolutionReceiptID: hash("evolution-receipt"),
        pairs,
      }),
    ),
  ])

  try {
    const result = await run(script, [
      "build",
      "--contract",
      contract,
      "--spec",
      spec,
      "--output",
      output,
      "--report",
      report,
    ])
    expect(result.code).toBe(0)
    const request = JSON.parse(await Bun.file(output).text())
    const targets = JSON.parse(await Bun.file(report).text())
    expect(request).toMatchObject({
      schemaVersion: 1,
      subject,
      validator: { name: "design-replay-interventions", version: 1, scriptSHA256: validatorSHA256 },
    })
    expect(request.evaluatorToken).toBeUndefined()
    expect(request.pairs).toHaveLength(9)
    expect(targets).toMatchObject({
      candidateID: subject.id,
      families: { model_transfer: 3, replay: 3, retune: 3 },
    })
    expect(targets.targets[0].controlSHA256).toBe(digest(request.pairs[0].control))

    const invalid = structuredClone(JSON.parse(await Bun.file(spec).text()))
    invalid.pairs[0].arm.condition.context = artifact("substituted-context")
    await Bun.write(spec, JSON.stringify(invalid))
    const rejected = await run(script, [
      "build",
      "--contract",
      contract,
      "--spec",
      spec,
      "--output",
      output,
      "--report",
      report,
    ])
    expect(rejected.code).toBe(2)
    expect(rejected.stderr).toContain("may change only model")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("simulator-validation accepts a convergent invariant-preserving study", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-simulator-"))
  const source = path.join(dir, "study.json")
  const output = path.join(dir, "report.json")
  await Bun.write(
    source,
    JSON.stringify({
      simulator: {
        name: "reference-solver",
        version: "1.0.0",
        command: "reference-solver case.json",
        configSHA256: "0".repeat(64),
      },
      expectedOrder: 2,
      orderTolerance: 0.1,
      maxResidual: 1e-8,
      invariantTolerances: { mass_drift: 1e-6 },
      levels: [
        { label: "coarse", h: 0.1, error: 0.01, residual: 1e-9, invariants: { mass_drift: 2e-7 } },
        { label: "medium", h: 0.05, error: 0.0025, residual: 2e-9, invariants: { mass_drift: 3e-7 } },
        { label: "fine", h: 0.025, error: 0.000625, residual: 3e-9, invariants: { mass_drift: 4e-7 } },
      ],
    }),
  )

  try {
    const result = await run("physics/simulator-validation/scripts/validate_convergence.py", [
      source,
      "--output",
      output,
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(await Bun.file(output).text())
    expect(report.passed).toBe(true)
    expect(report.medianObservedOrder).toBeCloseTo(2)
    expect(report.checks["invariant:mass_drift"]).toBe(true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("simulator-validation fails a refinement study with an excessive residual", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-simulator-"))
  const source = path.join(dir, "study.json")
  await Bun.write(
    source,
    JSON.stringify({
      simulator: { name: "solver", version: "1", command: "solver case", configSHA256: "a".repeat(64) },
      expectedOrder: 1,
      orderTolerance: 0,
      maxResidual: 1e-8,
      levels: [
        { label: "coarse", h: 0.1, error: 0.1, residual: 1e-9 },
        { label: "medium", h: 0.05, error: 0.05, residual: 2e-8 },
        { label: "fine", h: 0.025, error: 0.025, residual: 1e-9 },
      ],
    }),
  )

  try {
    const result = await run("physics/simulator-validation/scripts/validate_convergence.py", [source])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).checks.residual_bound).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("scientific-ablation-design accepts matched one-factor contrasts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ablation-"))
  const source = path.join(dir, "plan.json")
  const output = path.join(dir, "report.json")
  const context = { seeds: [1, 2, 3], budget: { candidates: 30 }, split: "held-out", evaluator: "eval-sha" }
  await Bun.write(
    source,
    JSON.stringify({
      metric: { name: "score", direction: "maximize" },
      baseline: { id: "full", config: { memory: "verified", search: "ucb" }, ...context },
      claims: [{ id: "memory-value", factor: "memory", from: "verified", to: "none" }],
      arms: [{ id: "no-memory", config: { memory: "none", search: "ucb" }, ...context }],
    }),
  )

  try {
    const result = await run("research/scientific-ablation-design/scripts/validate_ablation_plan.py", [
      source,
      "--output",
      output,
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(await Bun.file(output).text())
    expect(report.contrasts).toEqual([{ claim: "memory-value", baseline: "full", arm: "no-memory", factor: "memory" }])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("scientific-ablation-design rejects budget drift", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ablation-"))
  const source = path.join(dir, "plan.json")
  await Bun.write(
    source,
    JSON.stringify({
      metric: { name: "score", direction: "maximize" },
      baseline: {
        id: "full",
        config: { memory: "verified" },
        seeds: [1, 2],
        budget: { candidates: 30 },
        split: "held-out",
        evaluator: "eval-sha",
      },
      claims: [{ id: "memory-value", factor: "memory", from: "verified", to: "none" }],
      arms: [
        {
          id: "no-memory",
          config: { memory: "none" },
          seeds: [1, 2],
          budget: { candidates: 100 },
          split: "held-out",
          evaluator: "eval-sha",
        },
      ],
    }),
  )

  try {
    const result = await run("research/scientific-ablation-design/scripts/validate_ablation_plan.py", [source])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("drifts seed, budget, split, or evaluator")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("run-proactive-evaluation commits a token-free score-history pool", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-proactive-evaluation-"))
  const script = "research/run-proactive-evaluation/scripts/preflight.ts"
  const input = path.join(dir, "private.jsonl")
  const protocolFile = path.join(dir, "protocol.json")
  const output = path.join(dir, "public.json")
  const rows = [
    { id: "case-b", hidden: { prompt: "secret-b", target: 2 }, sourceLosses: [0.2, 0.3, 0.4], stratum: "b" },
    { id: "case-a", hidden: { prompt: "secret-a", target: 1 }, sourceLosses: [0.1, 0.2, 0.3], stratum: "a", weight: 2 },
    { id: "case-c", hidden: { prompt: "secret-c", target: 3 }, sourceLosses: [0.5, 0.4, 0.3], stratum: "c" },
  ]
  const protocol = {
    sourceModels: ["source-a", "source-b", "source-c"],
    selectionSHA256: hash("gmm-selection"),
    selectionMethod: "pca-gmm-profile-v1",
    calibrationSamples: 2,
    maxCalibrationMAE: 0.1,
  }
  try {
    await Promise.all([
      Bun.write(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`),
      Bun.write(protocolFile, JSON.stringify(protocol)),
    ])
    const valid = await bun(script, ["--input", input, "--protocol", protocolFile, "--out", output])
    expect(valid.code).toBe(0)
    expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, tokenFree: true, probes: 3 })
    const payload = JSON.parse(await Bun.file(output).text())
    expect(payload.probes.map((probe: { id: string }) => probe.id)).toEqual(["case-a", "case-b", "case-c"])
    expect(JSON.stringify(payload)).not.toContain("secret-")
    expect(payload.transfer.poolSHA256).toBe(hash(JSON.stringify(payload.probes)))
    expect(payload.transfer.sourceManifestSHA256).toBe(
      hash(
        JSON.stringify({
          sourceModels: protocol.sourceModels,
          scores: payload.probes.map((probe: { id: string; sourceLosses: number[] }) => ({
            id: probe.id,
            sourceLosses: probe.sourceLosses,
          })),
        }),
      ),
    )
    expect(
      HarnessContract.Audit.parse({
        mode: "performance",
        budget: 2,
        minSamples: 2,
        transfer: payload.transfer,
        promotionRequired: true,
      }).transfer,
    ).toEqual(payload.transfer)

    await Bun.write(input, `${JSON.stringify({ ...rows[0], sourceLosses: [0.1, 0.2] })}\n${JSON.stringify(rows[1])}\n`)
    const drift = await bun(script, ["--input", input, "--protocol", protocolFile, "--out", output])
    expect(drift.code).toBe(1)
    expect(drift.stderr).toContain("source dimension drifted")

    await Bun.write(protocolFile, JSON.stringify({ ...protocol, evaluatorToken: "must-not-touch-disk" }))
    const token = await bun(script, ["--input", input, "--protocol", protocolFile, "--out", output])
    expect(token.code).toBe(1)
    expect(token.stderr).toContain("unknown fields")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("run-topic-aware-failure-discovery salts definitions and emits a bindable protocol", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-topic-failure-"))
  const script = "research/run-topic-aware-failure-discovery/scripts/preflight.ts"
  const manifestFile = path.join(dir, "manifest.json")
  const firstSalt = "a".repeat(64)
  const definitions = ["molecular and organismal biology", "mechanics and field theory"]
  const names = [
    "topic-model",
    "generator",
    "correctness-validator",
    "topic-validator",
    "novelty-validator",
    "embedding-model",
  ]
  const identity = (name: string) => ({
    name,
    version: "1",
    promptPath: `${name}.prompt.txt`,
    configPath: `${name}.config.json`,
  })
  const manifest = {
    sourcePoolSHA256: hash("audit-pool"),
    topicSaltPath: "salt.txt",
    topics: [
      { id: "biology", definition: definitions[0] },
      { id: "physics", definition: definitions[1] },
    ],
    topicModel: { kind: "predefined", ...identity("topic-model") },
    generator: identity("generator"),
    validators: {
      correctness: identity("correctness-validator"),
      topic: identity("topic-validator"),
      novelty: identity("novelty-validator"),
    },
    embedding: { ...identity("embedding-model"), dimensions: 8 },
    budget: 6,
    anchorsPerAttempt: 2,
    failureThreshold: 0.5,
  }
  try {
    await Promise.all([
      ...names.flatMap((name) => [
        Bun.write(path.join(dir, `${name}.prompt.txt`), `private prompt for ${name}`),
        Bun.write(path.join(dir, `${name}.config.json`), JSON.stringify({ actor: name, seed: 7 })),
      ]),
      Bun.write(path.join(dir, "salt.txt"), firstSalt),
      Bun.write(manifestFile, JSON.stringify(manifest)),
    ])
    const valid = await bun(script, [manifestFile])
    expect(valid.code).toBe(0)
    const payload = JSON.parse(valid.stdout)
    expect(HarnessContract.FailureDiscovery.parse(payload.protocol)).toEqual(payload.protocol)
    expect(payload.protocol.topics.map((topic: { id: string }) => topic.id)).toEqual(["biology", "physics"])
    const privateValues = [
      ...definitions,
      firstSalt,
      ...names.flatMap((name) => [`private prompt for ${name}`, JSON.stringify({ actor: name, seed: 7 })]),
    ]
    for (const secret of privateValues) expect(valid.stdout).not.toContain(secret)

    await Bun.write(path.join(dir, "salt.txt"), "b".repeat(64))
    const salted = await bun(script, [manifestFile])
    expect(salted.code).toBe(0)
    expect(JSON.parse(salted.stdout).protocol.topics).not.toEqual(payload.protocol.topics)

    await Bun.write(path.join(dir, "salt.txt"), "too-short")
    const short = await bun(script, [manifestFile])
    expect(short.code).toBe(1)
    expect(short.stderr).toContain("at least 32 bytes")

    await Bun.write(path.join(dir, "salt.txt"), firstSalt)
    await Bun.write(manifestFile, JSON.stringify({ ...manifest, evaluatorToken: "must-not-touch-disk" }))
    const unknown = await bun(script, [manifestFile])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown fields: evaluatorToken")

    await Bun.write(
      manifestFile,
      JSON.stringify({ ...manifest, topics: [{ id: "__proto__", definition: definitions[0] }, manifest.topics[1]] }),
    )
    const unsafe = await bun(script, [manifestFile])
    expect(unsafe.code).toBe(1)
    expect(unsafe.stderr).toContain("opaque safe identifier")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("run-clean-room-synthesis hides answer facts and emits a bindable factuality protocol", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-clean-room-synthesis-"))
  const script = "research/run-clean-room-synthesis/scripts/preflight.ts"
  const manifestFile = path.join(dir, "manifest.json")
  const salt = "private-random-salt-material-00000000000000000000000000000000"
  const reference = "The private systematic-review conclusion must never enter the candidate process."
  const facts = [
    { id: "fact-1", text: "The intervention reduced the primary endpoint." },
    { id: "fact-2", text: "The evidence certainty was moderate." },
  ]
  const names = ["decomposer", "precision", "recall"]
  const identity = (name: string) => ({
    name,
    version: "1",
    promptPath: `${name}.prompt.txt`,
    configPath: `${name}.config.json`,
  })
  const manifest = {
    query: "What conclusion follows from the pre-cutoff evidence?",
    referenceTextPath: "reference.txt",
    referenceFacts: facts,
    factSaltPath: "salt.txt",
    cutoff: "2026-01-31",
    tools: ["google_search", "paper_search", "web_browse"],
    traceSchemaPath: "trace.schema.json",
    filterPolicyPath: "filter.policy.json",
    maxToolEvents: 40,
    decomposer: identity("decomposer"),
    judges: { precision: identity("precision"), recall: identity("recall") },
    minGeneratedFacts: 2,
    minPrecision: 0.4,
    minRecall: 0.4,
    minF1: 0.4,
  }
  try {
    await Promise.all([
      Bun.write(path.join(dir, "reference.txt"), reference),
      Bun.write(path.join(dir, "salt.txt"), salt),
      Bun.write(path.join(dir, "trace.schema.json"), JSON.stringify({ type: "array", owner: "evaluator" })),
      Bun.write(path.join(dir, "filter.policy.json"), JSON.stringify({ forbidden: ["cochrane.org"] })),
      ...names.flatMap((name) => [
        Bun.write(path.join(dir, `${name}.prompt.txt`), `private ${name} prompt`),
        Bun.write(path.join(dir, `${name}.config.json`), JSON.stringify({ actor: name, seed: 19 })),
      ]),
      Bun.write(manifestFile, JSON.stringify(manifest)),
    ])
    const valid = await bun(script, [manifestFile])
    expect(valid.code).toBe(0)
    const payload = JSON.parse(valid.stdout)
    expect(HarnessContract.ScientificSynthesis.parse(payload.protocol)).toEqual(payload.protocol)
    expect(payload.referenceManifest).toHaveLength(2)
    expect(payload.referenceManifest.map((fact: { id: string }) => fact.id)).toEqual(["fact-1", "fact-2"])
    for (const secret of [
      reference,
      salt,
      ...facts.map((fact) => fact.text),
      ...names.flatMap((name) => [`private ${name} prompt`, JSON.stringify({ actor: name, seed: 19 })]),
    ]) {
      expect(valid.stdout).not.toContain(secret)
    }

    await Bun.write(path.join(dir, "salt.txt"), "different-private-random-salt-material-000000000000000000000000")
    const salted = await bun(script, [manifestFile])
    expect(salted.code).toBe(0)
    expect(JSON.parse(salted.stdout).referenceManifest).not.toEqual(payload.referenceManifest)

    await Bun.write(path.join(dir, "salt.txt"), "too-short")
    const short = await bun(script, [manifestFile])
    expect(short.code).toBe(1)
    expect(short.stderr).toContain("at least 32 bytes")

    await Bun.write(path.join(dir, "salt.txt"), salt)
    await Bun.write(manifestFile, JSON.stringify({ ...manifest, cutoff: "2026-02-31" }))
    const date = await bun(script, [manifestFile])
    expect(date.code).toBe(1)
    expect(date.stderr).toContain("ISO calendar date")

    await Bun.write(
      manifestFile,
      JSON.stringify({
        ...manifest,
        judges: { precision: identity("precision"), recall: identity("precision") },
      }),
    )
    const duplicate = await bun(script, [manifestFile])
    expect(duplicate.code).toBe(1)
    expect(duplicate.stderr).toContain("distinct prompt commitments")

    await Bun.write(manifestFile, JSON.stringify({ ...manifest, evaluatorToken: "must-not-touch-disk" }))
    const unknown = await bun(script, [manifestFile])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown fields: evaluatorToken")

    await Bun.write(
      manifestFile,
      JSON.stringify({ ...manifest, referenceFacts: [{ id: "__proto__", text: facts[0]!.text }, facts[1]] }),
    )
    const unsafe = await bun(script, [manifestFile])
    expect(unsafe.code).toBe(1)
    expect(unsafe.stderr).toContain("opaque safe identifier")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("record-human-ai-autonomy hashes private interactions and emits a token-free trace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-human-ai-autonomy-"))
  const script = "research/record-human-ai-autonomy/scripts/preflight.ts"
  const manifestFile = path.join(dir, "manifest.json")
  const protocolFile = path.join(dir, "preflight.json")
  const traceFile = path.join(dir, "trace.json")
  const startedAt = Date.now()
  const problem = "Private held-out benchmark problem"
  const result = "Private autonomous scientific solution"
  const token = "private-evaluator-capability-must-never-be-emitted"
  const manifest = {
    claimedLevel: "essentially_autonomous",
    recorder: { name: "interaction-recorder", version: "1", artifactPath: "recorder.bin" },
    traceSchemaPath: "trace.schema.json",
    classificationPolicyPath: "classification.policy.md",
    maxEvents: 12,
    disclosure: "evaluator_retained",
  }
  const trace = {
    sessionID: "native-autonomy",
    subject: { type: "run", id: "run-native-autonomy" },
    artifactPath: "solution.txt",
    rawLogPath: "raw-log.jsonl",
    startedAt,
    endedAt: startedAt + 1,
    events: [
      {
        sequence: 1,
        at: startedAt,
        actor: "benchmark",
        kind: "problem_statement",
        contribution: "problem",
        contentPath: "problem.txt",
        evidence: ["private://raw-log#1"],
      },
      {
        sequence: 2,
        at: startedAt + 1,
        actor: "agent",
        kind: "artifact_edit",
        contribution: "core",
        contentPath: "solution.txt",
        artifactAfterPath: "solution.txt",
        evidence: ["private://raw-log#2"],
      },
    ],
  }
  try {
    await Promise.all([
      Bun.write(path.join(dir, "recorder.bin"), "frozen recorder executable"),
      Bun.write(path.join(dir, "trace.schema.json"), JSON.stringify({ owner: "evaluator_runtime" })),
      Bun.write(path.join(dir, "classification.policy.md"), "Aletheia contribution classes"),
      Bun.write(path.join(dir, "problem.txt"), problem),
      Bun.write(path.join(dir, "solution.txt"), result),
      Bun.write(path.join(dir, "raw-log.jsonl"), `${problem}\n${result}\n${token}\n`),
      Bun.write(manifestFile, JSON.stringify(manifest)),
      Bun.write(traceFile, JSON.stringify(trace)),
    ])
    const frozen = await bun(script, ["protocol", manifestFile])
    expect(frozen.code).toBe(0)
    const protocol = JSON.parse(frozen.stdout)
    expect(HarnessContract.HumanAIAutonomy.parse(protocol.protocol)).toEqual(protocol.protocol)
    await Bun.write(protocolFile, frozen.stdout)

    const prepared = await bun(script, ["submission", protocolFile, traceFile])
    expect(prepared.code).toBe(0)
    const payload = JSON.parse(prepared.stdout)
    expect(HarnessAutonomy.Submit.parse({ ...payload.submission, evaluatorToken: "x".repeat(32) })).toMatchObject({
      sessionID: "native-autonomy",
      artifactSHA256: hash(result),
      trace: { complete: true, events: [{ sequence: 1 }, { sequence: 2 }] },
    })
    expect(payload.preview).toMatchObject({
      claimedLevel: "essentially_autonomous",
      derivedLevel: "essentially_autonomous",
      humanSubstantiveEvents: 0,
      agentSubstantiveEvents: 1,
    })
    for (const secret of [problem, result, token]) expect(prepared.stdout).not.toContain(secret)

    const gapped = structuredClone(trace)
    gapped.events[1]!.sequence = 3
    await Bun.write(traceFile, JSON.stringify(gapped))
    const invalid = await bun(script, ["submission", protocolFile, traceFile])
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain("contiguous")

    await Bun.write(manifestFile, JSON.stringify({ ...manifest, evaluatorToken: token }))
    const secret = await bun(script, ["protocol", manifestFile])
    expect(secret.code).toBe(1)
    expect(secret.stderr).toContain("unknown fields: evaluatorToken")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("verify-formal-proof freezes a full external checker stack and emits token-free proof evidence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-formal-proof-"))
  const script = "research/verify-formal-proof/scripts/preflight.ts"
  const manifestFile = path.join(dir, "manifest.json")
  const protocolFile = path.join(dir, "preflight.json")
  const evidenceFile = path.join(dir, "evidence.json")
  const startedAt = Date.now()
  const challenge = "private trusted theorem challenge"
  const proof = "theorem target : True := by trivial"
  const transcript = "private checker output accepted"
  const token = "private-formal-evaluator-capability-must-never-be-emitted"
  const verifiers = HarnessContract.FormalVerifierRole.options.map((role) => ({
    role,
    name: `native-${role}`,
    version: "1",
    artifactPath: `${role}.bin`,
  }))
  const manifest = {
    tier: "external_crosscheck",
    relation: "exact_proof",
    challengePath: "challenge.lean",
    statementPath: "statement.lean",
    declaration: "Native.target",
    module: "Native.Proof",
    leanVersion: "4.33.0",
    leanToolchainPath: "lean-toolchain",
    lakeManifestPath: "lake-manifest.json",
    dependencyTreePath: "deps.json",
    verifiers,
    sandboxImagePath: "sandbox.img",
    allowedAxioms: ["Classical.choice", "Quot.sound", "propext"],
    maxFiles: 16,
  }
  const evidence = {
    sessionID: "native-formal-proof",
    subject: { type: "run", id: "run-native-formal-proof" },
    artifactPath: "proof.lean",
    manifest: {
      complete: true,
      files: [
        { path: "statement.lean", role: "statement" },
        { path: "proof.lean", role: "proof" },
        { path: "lean-toolchain", role: "lean_toolchain" },
        { path: "lake-manifest.json", role: "lake_manifest" },
        { path: "deps.json", role: "dependency_tree" },
        { path: "challenge.lean", role: "challenge" },
      ],
    },
    verification: {
      startedAt,
      endedAt: startedAt + 1,
      build: { exitCode: 0, warnings: 0, transcriptPath: "build.log" },
      source: { complete: true, findings: [], transcriptPath: "source.log" },
      axioms: {
        complete: true,
        typesTraversed: true,
        observed: ["propext", "Classical.choice", "Quot.sound"],
        transcriptPath: "axioms.log",
      },
      fresh: { fresh: true, exitCode: 0, transcriptPath: "fresh.log" },
      external: {
        sandboxed: true,
        challengeMatched: true,
        proofTermPath: "proof.term",
        transcriptPath: "comparator.log",
        checks: [
          { role: "lean_kernel", accepted: true, transcriptPath: "external-lean.log" },
          { role: "external_checker", accepted: true, transcriptPath: "external-independent.log" },
        ],
      },
    },
  }
  try {
    await Promise.all([
      Bun.write(path.join(dir, "challenge.lean"), challenge),
      Bun.write(path.join(dir, "statement.lean"), "Native.target : True"),
      Bun.write(path.join(dir, "proof.lean"), proof),
      Bun.write(path.join(dir, "lean-toolchain"), "leanprover/lean4:v4.33.0"),
      Bun.write(path.join(dir, "lake-manifest.json"), JSON.stringify({ packages: [] })),
      Bun.write(path.join(dir, "deps.json"), JSON.stringify({ closure: ["mathlib"] })),
      Bun.write(path.join(dir, "sandbox.img"), "frozen formal verification sandbox"),
      Bun.write(path.join(dir, "proof.term"), "serialized proof term"),
      ...verifiers.map((item) => Bun.write(path.join(dir, item.artifactPath), `binary:${item.role}`)),
      ...[
        "build.log",
        "source.log",
        "axioms.log",
        "fresh.log",
        "comparator.log",
        "external-lean.log",
        "external-independent.log",
      ].map((name) => Bun.write(path.join(dir, name), `${transcript}:${name}:${token}`)),
      Bun.write(manifestFile, JSON.stringify(manifest)),
      Bun.write(evidenceFile, JSON.stringify(evidence)),
    ])
    const frozen = await bun(script, ["protocol", manifestFile])
    expect(frozen.code).toBe(0)
    const preflight = JSON.parse(frozen.stdout)
    expect(HarnessContract.FormalProof.parse(preflight.protocol)).toEqual(preflight.protocol)
    await Bun.write(protocolFile, frozen.stdout)

    const prepared = await bun(script, ["submission", protocolFile, evidenceFile])
    expect(prepared.code).toBe(0)
    const payload = JSON.parse(prepared.stdout)
    const submission = HarnessFormal.Submit.parse({ ...payload.submission, evaluatorToken: "x".repeat(32) })
    expect(submission).toMatchObject({
      sessionID: "native-formal-proof",
      relation: "exact_proof",
      artifactSHA256: hash(proof),
      manifest: { complete: true },
      verification: {
        build: { exitCode: 0, warnings: 0 },
        source: { complete: true, findings: [] },
        axioms: { complete: true, typesTraversed: true },
        fresh: { fresh: true, exitCode: 0 },
        external: { sandboxed: true, challengeMatched: true },
      },
    })
    expect(submission.manifest.files[0]?.path).toBe("challenge.lean")
    expect(payload.preview).toMatchObject({
      tier: "external_crosscheck",
      relation: "exact_proof",
      files: 6,
      artifactSHA256: hash(proof),
    })
    for (const secret of [challenge, proof, transcript, token]) expect(prepared.stdout).not.toContain(secret)

    await Bun.write(manifestFile, JSON.stringify({ ...manifest, allowedAxioms: ["sorryAx"] }))
    const sorry = await bun(script, ["protocol", manifestFile])
    expect(sorry.code).toBe(1)
    expect(sorry.stderr).toContain("never include sorryAx")

    await Bun.write(manifestFile, JSON.stringify({ ...manifest, evaluatorToken: token }))
    const secret = await bun(script, ["protocol", manifestFile])
    expect(secret.code).toBe(1)
    expect(secret.stderr).toContain("unknown fields: evaluatorToken")

    await Bun.write(manifestFile, JSON.stringify({ ...manifest, challengePath: "../private-challenge.lean" }))
    const escaped = await bun(script, ["protocol", manifestFile])
    expect(escaped.code).toBe(1)
    expect(escaped.stderr).toContain("escapes its evidence directory")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("operate-proof-blueprint freezes architecture and emits token-free exact-placeholder attempts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-proof-blueprint-"))
  const script = "research/operate-proof-blueprint/scripts/preflight.ts"
  const manifestFile = path.join(dir, "manifest.json")
  const protocolFile = path.join(dir, "preflight.json")
  const leaseFile = path.join(dir, "lease.json")
  const evidenceFile = path.join(dir, "evidence.json")
  const now = Date.now()
  const token = "private-blueprint-evaluator-token"
  const files = {
    "schema.json": "proof-blueprint-schema-v1",
    "lean.bin": "frozen-lean-kernel",
    "validator.bin": "frozen-sketch-validator",
    "reviewer.bin": "frozen-decomposition-reviewer",
    "rubric.txt": "relevant easier plausible",
    "child.lean": "theorem Native.child : True := by trivial",
    "sketch.lean": "theorem Native.root (h : Native.child) : True := by trivial",
    "plan.txt": "reduce root to Native.child",
    "compiler.log": `compiler accepted ${token}`,
    "validator.log": `placeholders exactly Native.child ${token}`,
    "reviewer.log": `all rubric checks passed ${token}`,
    "feedback.txt": `no failure ${token}`,
  }
  const manifest = {
    graphSchemaPath: "schema.json",
    compilerPath: "lean.bin",
    sketchValidatorPath: "validator.bin",
    reviewerPath: "reviewer.bin",
    reviewerPromptPath: "rubric.txt",
    maxNodes: 32,
    maxDepth: 6,
    maxParallel: 4,
    maxAttemptsPerGoal: 3,
    maxRefinementsPerGoal: 2,
    leaseDurationMs: 60_000,
  }
  const lease = {
    id: hash("lease"),
    goalID: hash("goal"),
    revision: 1,
    ordinal: 0,
    status: "open",
    issuedAt: now,
    expiresAt: now + 60_000,
  }
  const evidence = {
    sessionID: "native-proof-blueprint",
    kind: "decomposition",
    artifactPath: "sketch.lean",
    informalPlanPath: "plan.txt",
    children: [{ statementPath: "child.lean", declaration: "Native.child", module: "Native.Blueprint" }],
    compiler: {
      artifactPath: "lean.bin",
      statementMatched: true,
      exitCode: 0,
      warnings: 0,
      transcriptPath: "compiler.log",
      feedbackPath: "feedback.txt",
      startedAt: now,
      endedAt: now + 1,
    },
    validator: { artifactPath: "validator.bin", transcriptPath: "validator.log" },
    review: {
      artifactPath: "reviewer.bin",
      promptPath: "rubric.txt",
      relevant: true,
      easier: true,
      plausible: true,
      transcriptPath: "reviewer.log",
    },
  }
  try {
    await Promise.all([
      ...Object.entries(files).map(([name, value]) => Bun.write(path.join(dir, name), value)),
      Bun.write(manifestFile, JSON.stringify(manifest)),
      Bun.write(leaseFile, JSON.stringify(lease)),
      Bun.write(evidenceFile, JSON.stringify(evidence)),
    ])
    const frozen = await bun(script, ["protocol", manifestFile])
    expect(frozen.code).toBe(0)
    const preflight = JSON.parse(frozen.stdout)
    expect(HarnessContract.ProofBlueprint.parse(preflight.blueprint)).toEqual(preflight.blueprint)
    await Bun.write(protocolFile, frozen.stdout)

    const prepared = await bun(script, ["attempt", protocolFile, leaseFile, evidenceFile])
    expect(prepared.code).toBe(0)
    const payload = JSON.parse(prepared.stdout)
    const submission = HarnessBlueprint.DecompositionSubmit.parse({
      ...payload.submission,
      evaluatorToken: "x".repeat(32),
    })
    expect(submission).toMatchObject({
      sessionID: "native-proof-blueprint",
      kind: "decomposition",
      leaseID: lease.id,
      children: [{ declaration: "Native.child", module: "Native.Blueprint" }],
      verification: { placeholderDeclarations: ["Native.child"], statementMatched: true, exitCode: 0 },
      review: { relevant: true, easier: true, plausible: true },
    })
    for (const secret of [files["child.lean"], files["sketch.lean"], token]) {
      expect(prepared.stdout).not.toContain(secret)
    }

    await Bun.write(path.join(dir, "other-validator.bin"), "substituted-validator")
    await Bun.write(
      evidenceFile,
      JSON.stringify({ ...evidence, validator: { ...evidence.validator, artifactPath: "other-validator.bin" } }),
    )
    const changed = await bun(script, ["attempt", protocolFile, leaseFile, evidenceFile])
    expect(changed.code).toBe(1)
    expect(changed.stderr).toContain("does not match the frozen blueprint")

    await Bun.write(manifestFile, JSON.stringify({ ...manifest, compilerPath: "../private-lean.bin" }))
    const escaped = await bun(script, ["protocol", manifestFile])
    expect(escaped.code).toBe(1)
    expect(escaped.stderr).toContain("escapes its evidence directory")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
