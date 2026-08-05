import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessEvolution } from "../../src/session/harness/evolution"
import { HarnessIntervention } from "../../src/session/harness/intervention"
import { HarnessLaunch } from "../../src/session/harness/launch"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"
import { launchProtocol, launchSubmit, recipeSelection } from "../fixture/harness"

const sessions = new Set<string>()
const token = "intervention-evaluator-capability-token-000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const stable = (input: unknown): unknown => {
  if (Array.isArray(input)) return input.map(stable)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, stable(value)]),
  )
}
const digest = (input: unknown) => hash(JSON.stringify(stable(input)))

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) => [
      ...["bindings", "contracts", "evaluations", "evolution", "launches", "reports", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
      fs.rm(path.join(Global.Path.data, "harness", "interventions", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ]),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
  sessions.clear()
})

function evolution() {
  return HarnessContract.Evolution.parse({
    protocolVersion: "evolution-trace-v1",
    validatorSHA256: hash("trace-evolutionary-candidate.py:v1"),
    manifestSchemaSHA256: hash("evolution-source-manifest:v1"),
    lineAlgorithm: "sha256-exact-line-v1",
    roots: ["src"],
    extensions: [".ts"],
    exclude: [],
    maxFiles: 100,
    maxFileBytes: 100_000,
    maxTotalBytes: 1_000_000,
    maxSourceLines: 10_000,
    maxChangedLines: 1_000,
  })
}

function interventions() {
  return HarnessContract.Interventions.parse({
    protocolVersion: "intervention-study-v1",
    validatorSHA256: hash("design-replay-interventions.py:v1"),
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
  })
}

function task(sessionID: string): HarnessAdapter.Task {
  sessions.add(sessionID)
  const recipe = recipeSelection("mle")
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "mle",
    version: "2026.08",
    taskID: "controlled-intervention-task",
    split: "held_out",
    evaluator: { name: "official-runner", version: "3", source: "benchmark", token },
    objective: "Distinguish stable structural improvement from tuning and evaluator coupling",
    launch: launchProtocol("mle", recipe),
    recipe,
    evolution: evolution(),
    interventions: interventions(),
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "research-agent" },
    tools: ["read", "bash"],
    skills: [
      { name: "trace-evolutionary-candidate", version: "1", sha256: evolution().validatorSHA256 },
      { name: "design-replay-interventions", version: "1", sha256: interventions().validatorSHA256 },
    ],
    budget: { steps: 80, candidates: 2 },
    seed: 53,
    intervention: "autonomous",
    contamination: { policy: "hidden evaluator remains external", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const checks = (contract: HarnessContract.Info) =>
  HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`receipt:${check.id}`],
  }))

function snapshot(contract: HarnessContract.Info, content: string) {
  const protocol = contract.evolution!
  const files = HarnessEvolution.Files.parse([
    {
      path: "src/main.ts",
      sha256: hash(content),
      bytes: new TextEncoder().encode(content).byteLength,
      lineHashes: content.split("\n").flatMap((line) => (line ? [hash(line)] : [])),
    },
  ])
  return HarnessEvolution.Snapshot.parse({
    artifact: { uri: "artifact:candidate-manifest.json", sha256: HarnessEvolution.manifestSHA256(protocol, files) },
    schemaSHA256: protocol.manifestSchemaSHA256,
    files,
  })
}

async function candidate(contract: HarnessContract.Info) {
  const state = await HarnessSearch.read(contract.sessionID)
  const recommendation = HarnessSearch.recommend(state)
  const result = await HarnessSearch.add({
    sessionID: contract.sessionID,
    recommendationID: recommendation.id,
    parentIDs: recommendation.parentIDs,
    inspirationIDs: recommendation.inspirationIDs,
    branch: "structural-winner",
    proposal: "Evaluate a replayable structural candidate under controlled interventions",
    artifact: { uri: "artifact:structural-winner.tar.zst", sha256: hash("structural-winner") },
  })
  return result.state.candidates[result.id]!
}

async function trace(contract: HarnessContract.Info, item: HarnessSearch.Candidate) {
  const source = snapshot(contract, "export function solve() { return 42 }\n")
  return HarnessEvolution.record(
    {
      schemaVersion: 1,
      runID: contract.runID,
      sessionID: contract.sessionID,
      evaluatorToken: token,
      protocol: contract.evolution!,
      subject: { type: "candidate", id: item.id, artifact: item.artifact },
      snapshot: source,
      parents: [],
      validator: {
        name: "trace-evolutionary-candidate",
        version: 1,
        scriptSHA256: contract.evolution!.validatorSHA256,
      },
      evidence: ["artifact:trace-report.json"],
      evaluatedAt: Date.now(),
    },
    contract,
  )
}

function artifact(name: string) {
  return { uri: `artifact:${name}`, sha256: hash(name) }
}

function condition(seed: number): HarnessIntervention.Condition {
  return HarnessIntervention.Condition.parse({
    seed,
    model: { provider: "test", name: "primary-model", version: "1" },
    context: artifact("primary-context"),
    evaluator: { name: "official-runner", version: "3", source: "benchmark" },
    split: { name: "held_out", manifest: artifact("held-out-split") },
    environment: artifact("locked-environment"),
    budget: artifact("matched-budget"),
  })
}

function pairs(item: HarnessSearch.Candidate) {
  return [0, 1, 2].flatMap((index) => {
    const base = condition(100 + index)
    const subject = { artifact: item.artifact, condition: base }
    return [
      {
        family: "model_transfer" as const,
        index,
        control: subject,
        arm: {
          artifact: item.artifact,
          condition: { ...base, model: { provider: "test", name: "transfer-model", version: "2" } },
        },
        change: artifact(`model-transfer-${index}`),
      },
      {
        family: "replay" as const,
        index,
        control: subject,
        arm: subject,
        change: artifact(`replay-${index}`),
      },
      {
        family: "retune" as const,
        index,
        control: { artifact: artifact(`retuned-baseline-${index}`), condition: base },
        arm: subject,
        change: artifact(`retune-${index}`),
      },
    ]
  })
}

function initialize(contract: HarnessContract.Info, item: HarnessSearch.Candidate, receipt: HarnessEvolution.Info) {
  return HarnessIntervention.Initialize.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    subject: { type: "candidate", id: item.id, artifact: item.artifact },
    evolutionReceiptID: receipt.receiptID,
    validator: {
      name: "design-replay-interventions",
      version: 1,
      scriptSHA256: contract.interventions!.validatorSHA256,
    },
    pairs: pairs(item),
  })
}

async function setup(sessionID: string) {
  const contract = await HarnessAdapter.bind(task(sessionID))
  const launch = await HarnessLaunch.record(launchSubmit(contract, token), contract)
  await HarnessSearch.initialize({ sessionID, candidates: 2 })
  const item = await candidate(contract)
  const evolution = await trace(contract, item)
  return { contract, launch, item, evolution }
}

function scores(family: HarnessContract.InterventionFamily, role: "control" | "arm") {
  if (family === "retune") return role === "control" ? 0.7 : 0.9
  if (family === "model_transfer") return role === "control" ? 0.9 : 0.88
  return 0.9
}

async function observeAll(
  contract: HarnessContract.Info,
  item: HarnessSearch.Candidate,
  state: HarnessIntervention.State,
) {
  for (const pair of state.plan.pairs) {
    for (const role of ["control", "arm"] as const) {
      await HarnessIntervention.observe(
        item.id,
        {
          schemaVersion: 1,
          sessionID: contract.sessionID,
          evaluatorToken: token,
          pairID: pair.pairID,
          role,
          targetSHA256: digest(pair[role]),
          status: "passed",
          score: scores(pair.family, role),
          evidence: [`artifact:${pair.family}-${pair.index}-${role}.json`],
          evaluatedAt: Date.now(),
        },
        contract,
      )
    }
  }
}

function evaluation(
  contract: HarnessContract.Info,
  item: HarnessSearch.Candidate,
  launch: HarnessLaunch.Info,
  evolution: HarnessEvolution.Info,
  interventionReceiptID?: string,
  evaluatedAt = Date.now(),
) {
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    candidateID: item.id,
    launchReceiptID: launch.receiptID,
    evolutionReceiptID: evolution.receiptID,
    interventionReceiptID,
    status: "passed",
    score: 0.9,
    metrics: { score: 0.9 },
    checks: checks(contract),
    evidence: ["official:held-out-score.json"],
    evaluatedAt,
  })
}

describe("evaluator-owned controlled replay interventions", () => {
  test("derives replay stability, tuning gap, and model-transfer robustness without becoming fitness", async () => {
    const { contract, launch, item, evolution } = await setup("intervention-pass")
    const state = await HarnessIntervention.initialize(initialize(contract, item, evolution), contract)
    if (!state) throw new Error("Expected a frozen intervention plan")
    expect((await HarnessSearch.read(contract.sessionID)).candidates[item.id]!.result).toBeUndefined()
    await expect(HarnessIntervention.assess(contract.sessionID, item.id, contract)).rejects.toThrow("every frozen pair")
    await observeAll(contract, item, state)
    const receipt = await HarnessIntervention.assess(contract.sessionID, item.id, contract)
    expect(receipt).toMatchObject({ status: "passed", subject: { id: item.id } })
    expect(receipt.families.map((family) => ({ family: family.family, verdict: family.verdict }))).toEqual([
      { family: "model_transfer", verdict: "passed" },
      { family: "replay", verdict: "passed" },
      { family: "retune", verdict: "passed" },
    ])
    expect(receipt.families[0]!.meanEffect).toBeCloseTo(-0.02)
    expect(receipt.families[1]!.maxAbsoluteEffect).toBe(0)
    expect(receipt.families[2]!.meanEffect).toBeCloseTo(0.2)
    await expect(
      HarnessIntervention.assert({
        contract,
        receiptID: receipt.receiptID,
        candidateID: item.id,
        evolutionReceiptID: hash("substituted-evolution-receipt"),
        requirePassed: true,
        evaluatedAt: Date.now(),
        recordedAt: Date.now(),
      }),
    ).rejects.toThrow("does not match the evaluation's evolution receipt")
    const untraced = evaluation(contract, item, launch, evolution, receipt.receiptID)
    untraced.status = "failed"
    delete untraced.evolutionReceiptID
    await expect(HarnessAdapter.ingest(untraced)).rejects.toThrow("exact evolution receipt")
    await expect(HarnessAdapter.ingest(evaluation(contract, item, launch, evolution))).rejects.toThrow(
      "controlled intervention receipt",
    )
    const result = await HarnessAdapter.ingest(
      evaluation(contract, item, launch, evolution, receipt.receiptID, Math.max(Date.now(), receipt.observedAt) + 1),
    )
    expect(result.search?.bestID).toBe(item.id)
    expect(result.evaluation.interventionReceiptID).toBe(receipt.receiptID)
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation], search: result.search })
    expect(report.quality.interventionReceiptID).toBe(receipt.receiptID)
  })

  test("rejects extra differences, validator substitution, wrong targets, and mutable outcomes", async () => {
    const { contract, item, evolution } = await setup("intervention-substitution")
    const input = initialize(contract, item, evolution)
    const first = input.pairs.find((pair) => pair.family === "model_transfer")!
    await expect(
      HarnessIntervention.initialize(
        {
          ...input,
          pairs: input.pairs.map((pair) =>
            pair !== first
              ? pair
              : {
                  ...pair,
                  arm: {
                    ...pair.arm,
                    condition: { ...pair.arm.condition, context: artifact("also-substituted-context") },
                  },
                },
          ),
        },
        contract,
      ),
    ).rejects.toThrow("may change only model")
    await expect(
      HarnessIntervention.initialize(
        { ...input, validator: { ...input.validator, scriptSHA256: hash("substituted-validator") } },
        contract,
      ),
    ).rejects.toThrow("validator does not match")
    const state = await HarnessIntervention.initialize(input, contract)
    if (!state) throw new Error("Expected a frozen intervention plan")
    const pair = state.plan.pairs[0]!
    const base = {
      schemaVersion: 1 as const,
      sessionID: contract.sessionID,
      evaluatorToken: token,
      pairID: pair.pairID,
      role: "control" as const,
      targetSHA256: digest(pair.control),
      status: "passed" as const,
      score: 0.9,
      evidence: ["artifact:control.json"],
      evaluatedAt: Date.now(),
    }
    await expect(
      HarnessIntervention.observe(item.id, { ...base, targetSHA256: hash("wrong-target") }, contract),
    ).rejects.toThrow("does not match the frozen pair")
    const recorded = await HarnessIntervention.observe(item.id, base, contract)
    expect((await HarnessIntervention.observe(item.id, base, contract)).outcomeID).toBe(recorded.outcomeID)
    await expect(HarnessIntervention.observe(item.id, { ...base, score: 0.8 }, contract)).rejects.toThrow(
      "immutable once recorded",
    )
  })

  test("fails closed on incomplete execution, temporal post-selection, and stored derivation tampering", async () => {
    const { contract, launch, item, evolution } = await setup("intervention-tamper")
    const state = await HarnessIntervention.initialize(initialize(contract, item, evolution), contract)
    if (!state) throw new Error("Expected a frozen intervention plan")
    await observeAll(contract, item, state)
    const receipt = await HarnessIntervention.assess(contract.sessionID, item.id, contract)
    await expect(
      HarnessIntervention.observe(
        item.id,
        {
          schemaVersion: 1,
          sessionID: contract.sessionID,
          evaluatorToken: token,
          pairID: state.plan.pairs[0]!.pairID,
          role: "control",
          targetSHA256: digest(state.plan.pairs[0]!.control),
          status: "passed",
          score: 0.9,
          evidence: ["artifact:late.json"],
          evaluatedAt: Date.now(),
        },
        contract,
      ),
    ).rejects.toThrow("closed after assessment")
    await expect(
      HarnessAdapter.ingest(evaluation(contract, item, launch, evolution, receipt.receiptID, receipt.observedAt - 1)),
    ).rejects.toThrow("predates its controlled intervention observations")

    const target = path.join(
      Global.Path.data,
      "harness",
      "interventions",
      encodeURIComponent(contract.sessionID),
      `${item.id}.json`,
    )
    const stored = (await Bun.file(target).json()) as HarnessIntervention.State
    const original = structuredClone(stored)
    stored.receipt!.families[0]!.verdict = "failed"
    await Bun.write(target, JSON.stringify(stored))
    expect(await HarnessIntervention.read(contract.sessionID, item.id)).toBeNull()
    await expect(
      HarnessIntervention.assert({
        contract,
        receiptID: receipt.receiptID,
        candidateID: item.id,
        evolutionReceiptID: evolution.receiptID,
        requirePassed: true,
        evaluatedAt: Date.now(),
        recordedAt: Date.now(),
      }),
    ).rejects.toThrow("Unknown or corrupt")

    const outcome = structuredClone(original.outcomes[original.order[0]!]!)
    const forged = structuredClone(original)
    outcome.submissionID = hash("forged-submission")
    const payload = structuredClone(outcome) as Record<string, unknown>
    delete payload.outcomeID
    outcome.outcomeID = digest(payload)
    delete forged.outcomes[forged.order[0]!]
    forged.outcomes[outcome.outcomeID] = outcome
    forged.order[0] = outcome.outcomeID
    await Bun.write(target, JSON.stringify(forged))
    expect(await HarnessIntervention.read(contract.sessionID, item.id)).toBeNull()

    const protocol = structuredClone(original)
    protocol.plan.protocol.minPairs = 4
    const plan = structuredClone(protocol.plan) as unknown as Record<string, unknown>
    delete plan.planID
    protocol.plan.planID = digest(plan)
    protocol.receipt!.planID = protocol.plan.planID
    const assessment = structuredClone(protocol.receipt!) as unknown as Record<string, unknown>
    delete assessment.receiptID
    protocol.receipt!.receiptID = digest(assessment)
    await Bun.write(target, JSON.stringify(protocol))
    expect(await HarnessIntervention.read(contract.sessionID, item.id)).toBeNull()

    const swapped = structuredClone(original)
    swapped.plan.protocol.requiredForPromotion = false
    const swappedPlan = structuredClone(swapped.plan) as unknown as Record<string, unknown>
    delete swappedPlan.planID
    swapped.plan.planID = digest(swappedPlan)
    swapped.receipt!.planID = swapped.plan.planID
    const swappedReceipt = structuredClone(swapped.receipt!) as unknown as Record<string, unknown>
    delete swappedReceipt.receiptID
    swapped.receipt!.receiptID = digest(swappedReceipt)
    await Bun.write(target, JSON.stringify(swapped))
    expect(await HarnessIntervention.read(contract.sessionID, item.id)).not.toBeNull()
    await expect(
      HarnessIntervention.assert({
        contract,
        receiptID: swapped.receipt!.receiptID,
        candidateID: item.id,
        evolutionReceiptID: evolution.receiptID,
        requirePassed: true,
        evaluatedAt: Date.now(),
        recordedAt: Date.now(),
      }),
    ).rejects.toThrow("does not match the immutable harness contract")
  })

  test("protects intervention routes with the evaluator capability", async () => {
    const { contract, item, evolution } = await setup("intervention-routes")
    const app = HarnessRoutes()
    const created = await app.request("/interventions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialize(contract, item, evolution)),
    })
    expect(created.status).toBe(200)
    const state = (await created.json()) as HarnessIntervention.State
    expect(JSON.stringify(state)).not.toContain(token)
    const denied = await app.request(`/interventions/${item.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: "x".repeat(48) }),
    })
    expect(denied.status).not.toBe(200)
    const read = await app.request(`/interventions/${item.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: token }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ plan: { planID: state.plan.planID, subject: { id: item.id } } })
  })

  test("keeps studies optional and restricts them to traced numeric held-out optimization", async () => {
    const legacy = task("intervention-legacy")
    delete legacy.interventions
    expect((await HarnessAdapter.bind(legacy)).interventions).toBeUndefined()
    const base = await HarnessAdapter.bind(task("intervention-contract"))
    expect(() => HarnessContract.Info.parse({ ...base, profile: "theory" })).toThrow("optimize profile")
    expect(() => HarnessContract.Info.parse({ ...base, evolution: undefined })).toThrow("exact evolutionary provenance")
    expect(() =>
      HarnessContract.Info.parse({
        ...base,
        benchmark: { ...base.benchmark, split: "validation" },
      }),
    ).toThrow("held-out or release")
    expect(() =>
      HarnessContract.Info.parse({
        ...base,
        benchmark: { ...base.benchmark, direction: "pass", metric: undefined },
      }),
    ).toThrow("numeric benchmark metric")
  })
})
