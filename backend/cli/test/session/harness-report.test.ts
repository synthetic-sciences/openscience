import { describe, expect, test } from "bun:test"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

function contract(runID: string, direction: "maximize" | "minimize" = "maximize"): HarnessContract.Info {
  return HarnessContract.Info.parse({
    schemaVersion: 1,
    runID,
    sessionID: `session-${runID}`,
    objective: "Improve a fixed task",
    benchmark: {
      name: "mle",
      version: "1",
      taskID: "task",
      split: "held_out",
      evaluator: "official",
      evaluatorVersion: "1",
      evaluatorSource: "benchmark",
      metric: "score",
      direction,
      target: direction === "maximize" ? 0.9 : 0.1,
    },
    profile: "optimize",
    packs: ["ml"],
    model: { provider: "test", name: "model" },
    tools: [],
    skills: [],
    budget: { candidates: 10 },
    seed: 1,
    intervention: "autonomous",
    contamination: { policy: "hidden", hiddenTestsAccessible: false },
    createdAt: 1,
  })
}

function evaluation(input: HarnessContract.Info, score: number): HarnessEvaluation.Info {
  return HarnessEvaluation.Info.parse({
    schemaVersion: 1,
    runID: input.runID,
    sessionID: input.sessionID,
    evaluator: { name: "official", version: "1", source: "benchmark" },
    status: "passed",
    score,
    metrics: { score },
    checks: [{ id: "official", status: "passed", blocking: true, evidence: ["receipt"] }],
    evidence: ["report"],
    evaluatedAt: 2,
  })
}

const trace = (cost: number, total: number, wall: number): HarnessReport.Trace => ({
  cost,
  tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  totalCompletionTimeMs: wall,
  toolCalls: 4,
  searchCount: 1,
  dedupeHits: 0,
  retryCount: 0,
  failureCount: 0,
})

describe("harness quality-cost reports", () => {
  test("reports quality, target status, tokens, cost, and compatible comparison keys", () => {
    const baseline = contract("baseline")
    const first = HarnessReport.compile({
      contract: baseline,
      evaluations: [evaluation(baseline, 0.8)],
      trace: trace(2, 1_000, 5_000),
      generatedAt: 3,
    })
    const candidate = contract("candidate")
    const second = HarnessReport.compile({
      contract: candidate,
      evaluations: [evaluation(candidate, 0.9)],
      trace: trace(1.5, 900, 4_000),
      generatedAt: 3,
    })
    expect(first.comparisonKey).toBe(second.comparisonKey)
    expect(first.quality.targetReached).toBe(false)
    expect(second.quality.targetReached).toBe(true)
    expect(second.efficiency.tokens?.total).toBe(900)
    expect(HarnessReport.dominates(second, first)).toBe(true)
    expect(HarnessReport.frontier([first, second]).map((item) => item.runID)).toEqual(["candidate"])
    expect(HarnessReport.compare([first, second], "baseline")).toContainEqual({
      runID: "candidate",
      scoreImprovement: 0.09999999999999998,
      costDelta: -0.5,
      tokenDelta: -100,
      wallTimeDelta: -1000,
      pareto: true,
    })
  })

  test("uses direction-aware improvement for minimized metrics", () => {
    const base = contract("loss-base", "minimize")
    const better = contract("loss-better", "minimize")
    const first = HarnessReport.compile({ contract: base, evaluations: [evaluation(base, 0.4)], generatedAt: 3 })
    const second = HarnessReport.compile({ contract: better, evaluations: [evaluation(better, 0.2)], generatedAt: 3 })
    expect(HarnessReport.compare([first, second], "loss-base")[1]?.scoreImprovement).toBeCloseTo(0.2)
    expect(HarnessReport.dominates(second, first)).toBe(true)
  })

  test("reports adaptive controller telemetry and keeps static search out of the comparison set", () => {
    const adaptive = HarnessContract.Info.parse({
      ...contract("adaptive-report"),
      search: HarnessContract.adaptiveSearch,
    })
    const search = HarnessSearch.State.parse({
      schemaVersion: 4,
      proposalPolicy: "adaptive-v4",
      runID: adaptive.runID,
      sessionID: adaptive.sessionID,
      objective: adaptive.objective,
      evaluator: adaptive.benchmark.evaluator,
      metric: "score",
      direction: "maximize",
      objectives: [],
      controller: HarnessContract.adaptiveSearch,
      population: { mode: "islands", count: 2, initial: 2, topology: "ring", migrationInterval: 3 },
      budget: { candidates: 10, stall: 5 },
      status: "active",
      candidates: {},
      reservations: {},
      archiveIDs: [],
      stalled: 0,
      revision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const report = HarnessReport.compile({
      contract: adaptive,
      evaluations: [evaluation(adaptive, 0.8)],
      search,
      generatedAt: 3,
    })
    expect(report.search).toMatchObject({
      proposalPolicy: "adaptive-v4",
      controller: HarnessContract.adaptiveSearch,
      adaptation: { events: 0, stalled: 0, globalStagnation: false },
    })
    const staticContract = contract("static-report")
    const staticReport = HarnessReport.compile({
      contract: staticContract,
      evaluations: [evaluation(staticContract, 0.8)],
      generatedAt: 3,
    })
    expect(report.comparisonKey).not.toBe(staticReport.comparisonKey)
    expect(() => HarnessReport.compare([report, staticReport], report.runID)).toThrow("only comparable")
  })

  test("refuses cross-task comparisons instead of normalizing unlike metrics", () => {
    const first = contract("one")
    const other = HarnessContract.Info.parse({
      ...contract("two"),
      benchmark: { ...contract("two").benchmark, taskID: "other-task" },
    })
    const a = HarnessReport.compile({ contract: first, evaluations: [evaluation(first, 0.8)], generatedAt: 3 })
    const b = HarnessReport.compile({ contract: other, evaluations: [evaluation(other, 0.9)], generatedAt: 3 })
    expect(HarnessReport.dominates(b, a)).toBe(false)
    expect(() => HarnessReport.compare([a, b], "one")).toThrow("only comparable")
  })

  test("keeps different secondary-objective contracts out of one comparison", () => {
    const base = contract("objective-base")
    const multi = HarnessContract.Info.parse({
      ...contract("objective-multi"),
      benchmark: {
        ...contract("objective-multi").benchmark,
        objectives: [{ metric: "robustness", direction: "maximize" }],
        objectiveAudit: {
          schemaVersion: 1,
          planSHA256: "b".repeat(64),
          validatorSHA256: "c".repeat(64),
          contractSHA256: "d".repeat(64),
          guardIDs: ["semantic-regression"],
        },
      },
    })
    const first = HarnessReport.compile({ contract: base, evaluations: [evaluation(base, 0.8)], generatedAt: 3 })
    const result = HarnessEvaluation.Info.parse({
      ...evaluation(multi, 0.8),
      metrics: { score: 0.8, robustness: 0.7 },
    })
    const search = HarnessSearch.State.parse({
      schemaVersion: 4,
      proposalPolicy: "leased-v3",
      runID: multi.runID,
      sessionID: multi.sessionID,
      objective: multi.objective,
      evaluator: multi.benchmark.evaluator,
      metric: "score",
      direction: "maximize",
      objectives: multi.benchmark.objectives,
      population: { mode: "islands", count: 2, initial: 2, topology: "ring", migrationInterval: 3 },
      budget: { candidates: 10, stall: 5 },
      status: "active",
      candidates: {},
      archiveIDs: [],
      stalled: 0,
      revision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const second = HarnessReport.compile({ contract: multi, evaluations: [result], search, generatedAt: 3 })
    expect(second.search?.objectiveAudit).toEqual(multi.benchmark.objectiveAudit)
    expect(first.comparisonKey).not.toBe(second.comparisonKey)
    expect(() => HarnessReport.compare([first, second], "objective-base")).toThrow("only comparable")
    const changed = HarnessContract.Info.parse({
      ...multi,
      runID: "objective-audit-changed",
      sessionID: "session-objective-audit-changed",
      benchmark: {
        ...multi.benchmark,
        objectiveAudit: { ...multi.benchmark.objectiveAudit!, contractSHA256: "e".repeat(64) },
      },
    })
    const changedResult = HarnessEvaluation.Info.parse({
      ...result,
      runID: changed.runID,
      sessionID: changed.sessionID,
    })
    const third = HarnessReport.compile({ contract: changed, evaluations: [changedResult], generatedAt: 3 })
    expect(second.comparisonKey).not.toBe(third.comparisonKey)
    expect(() => HarnessReport.compare([second, third], "objective-multi")).toThrow("only comparable")
  })

  test("refuses comparisons across different simulator protocols", () => {
    const base = contract("simulation-one")
    const simulation = HarnessContract.Simulation.parse({
      kind: "pde",
      engine: {
        name: "solver",
        version: "1",
        commandSHA256: "a".repeat(64),
        configSHA256: "b".repeat(64),
      },
      problemSHA256: "c".repeat(64),
      reference: { kind: "analytic", identity: "reference", sha256: "d".repeat(64) },
      validation: {
        errorNorm: "L2",
        minLevels: 3,
        expectedOrder: 2,
        orderTolerance: 0.2,
        maxResidual: 1e-8,
        invariantTolerances: { mass_drift: 1e-6 },
        requiredStressTests: ["reference_replay"],
      },
    })
    const first = HarnessContract.Info.parse({ ...base, simulation })
    const second = HarnessContract.Info.parse({
      ...contract("simulation-two"),
      simulation: { ...simulation, engine: { ...simulation.engine, configSHA256: "e".repeat(64) } },
    })
    const a = HarnessReport.compile({ contract: first, evaluations: [evaluation(first, 0.8)], generatedAt: 3 })
    const b = HarnessReport.compile({ contract: second, evaluations: [evaluation(second, 0.9)], generatedAt: 3 })
    expect(a.comparisonKey).not.toBe(b.comparisonKey)
    expect(() => HarnessReport.compare([a, b], "simulation-one")).toThrow("only comparable")
  })

  test("keeps active-audit protocols and receipts in report provenance", () => {
    const base = contract("audit-report-base")
    const audited = HarnessContract.Info.parse({
      ...contract("audit-report-qualified"),
      audit: { mode: "performance", budget: 3, minSamples: 2 },
    })
    const plain = HarnessReport.compile({ contract: base, evaluations: [evaluation(base, 0.8)], generatedAt: 3 })
    const receiptID = "a".repeat(64)
    const result = HarnessEvaluation.Info.parse({ ...evaluation(audited, 0.8), auditReceiptID: receiptID })
    const report = HarnessReport.compile({ contract: audited, evaluations: [result], generatedAt: 3 })
    expect(report.quality.auditReceiptID).toBe(receiptID)
    expect(report.comparisonKey).not.toBe(plain.comparisonKey)
    expect(() => HarnessReport.compare([plain, report], plain.runID)).toThrow("only comparable")
  })

  test("refuses comparisons across different evaluator qualification protocols", () => {
    const audit = HarnessContract.EvaluatorAudit.parse({
      protocolVersion: "evaluator-audit-v1",
      auditor: { name: "meta-evaluator", version: "1", source: "external" },
      suite: { name: "judge-suite", version: "1", commitmentSHA256: "a".repeat(64) },
      minCleanCases: 2,
      minCasesPerFault: 1,
      requiredFaults: ["wrong_answer"],
      minSensitivity: 0.8,
      minSpecificity: 0.8,
      minBalancedAccuracy: 0.8,
      minFaultRecall: 0.8,
      maxBrierScore: 0.15,
    })
    const first = HarnessContract.Info.parse({ ...contract("judge-one"), evaluatorAudit: audit })
    const second = HarnessContract.Info.parse({
      ...contract("judge-two"),
      evaluatorAudit: { ...audit, suite: { ...audit.suite, commitmentSHA256: "b".repeat(64) } },
    })
    const a = HarnessReport.compile({ contract: first, evaluations: [evaluation(first, 0.8)], generatedAt: 3 })
    const b = HarnessReport.compile({ contract: second, evaluations: [evaluation(second, 0.9)], generatedAt: 3 })
    expect(a.comparisonKey).not.toBe(b.comparisonKey)
    expect(() => HarnessReport.compare([a, b], "judge-one")).toThrow("only comparable")
  })

  test("refuses comparisons across different controlled intervention protocols", () => {
    const evolution = HarnessContract.Evolution.parse({
      protocolVersion: "evolution-trace-v1",
      validatorSHA256: "a".repeat(64),
      manifestSchemaSHA256: "b".repeat(64),
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
    const interventions = HarnessContract.Interventions.parse({
      protocolVersion: "intervention-study-v1",
      validatorSHA256: "c".repeat(64),
      requiredForPromotion: true,
      minPairs: 3,
      maxPairs: 3,
      maxTotalPairs: 3,
      confidence: 0.95,
      required: ["replay"],
      rules: [{ family: "replay", mode: "max_absolute_effect", threshold: 0.01 }],
    })
    const first = HarnessContract.Info.parse({ ...contract("intervention-one"), evolution, interventions })
    const second = HarnessContract.Info.parse({
      ...contract("intervention-two"),
      evolution,
      interventions: {
        ...interventions,
        rules: [{ family: "replay", mode: "max_absolute_effect", threshold: 0.02 }],
      },
    })
    const a = HarnessReport.compile({ contract: first, evaluations: [evaluation(first, 0.8)], generatedAt: 3 })
    const b = HarnessReport.compile({ contract: second, evaluations: [evaluation(second, 0.9)], generatedAt: 3 })
    expect(a.comparisonKey).not.toBe(b.comparisonKey)
    expect(() => HarnessReport.compare([a, b], "intervention-one")).toThrow("only comparable")
  })

  test("refuses comparisons across different replicated evaluation protocols", () => {
    const replication = HarnessContract.Replication.parse({
      protocolVersion: "replicated-evaluation-v1",
      validatorSHA256: "a".repeat(64),
      environmentSHA256: "e".repeat(64),
      sampling: {
        design: "crossed-stratified-cluster-v1",
        stratumKind: "task",
        clusterKind: "seed",
        strata: [{ id: "task-0", commitmentSHA256: "b".repeat(64) }],
        clusters: [0, 1, 2, 3, 4].map((seed) => ({
          id: `seed-${seed}`,
          commitmentSHA256: seed.toString(16).repeat(64),
        })),
      },
      estimator: "iqm",
      interval: {
        method: "stratified-bootstrap-percentile-v1",
        confidence: 0.95,
        resamples: 1_000,
        seed: 17,
      },
      decision: { rule: "conservative-bound-v1", direction: "maximize", target: 0.9 },
      failurePolicy: "fail-closed",
    })
    const first = HarnessContract.Info.parse({ ...contract("replication-one"), replication })
    const second = HarnessContract.Info.parse({
      ...contract("replication-two"),
      replication: {
        ...replication,
        interval: { ...replication.interval, seed: 18 },
      },
    })
    const a = HarnessReport.compile({ contract: first, evaluations: [evaluation(first, 0.91)], generatedAt: 3 })
    const b = HarnessReport.compile({ contract: second, evaluations: [evaluation(second, 0.92)], generatedAt: 3 })
    expect(a.comparisonKey).not.toBe(b.comparisonKey)
    expect(() => HarnessReport.compare([a, b], "replication-one")).toThrow("only comparable")
  })

  test("reports only final fidelity scores even when a later screening record is present", () => {
    const staged = HarnessContract.Info.parse({
      ...contract("staged"),
      benchmark: {
        ...contract("staged").benchmark,
        fidelities: [
          { id: "smoke", final: false },
          { id: "official", final: true },
        ],
      },
    })
    const final = HarnessEvaluation.Info.parse({
      ...evaluation(staged, 0.85),
      fidelity: { stage: "official", final: true },
      usage: { wallTimeMs: 100, costUSD: 0.2 },
    })
    const screen = HarnessEvaluation.Info.parse({
      ...evaluation(staged, 0.99),
      fidelity: { stage: "smoke", final: false },
      usage: { wallTimeMs: 10, costUSD: 0.01 },
    })
    const report = HarnessReport.compile({ contract: staged, evaluations: [final, screen], generatedAt: 3 })
    expect(report.quality.score).toBe(0.85)
    expect(report.efficiency).toMatchObject({
      costUSD: 0.21000000000000002,
      evaluatorCostUSD: 0.21000000000000002,
      wallTimeMs: 110,
      evaluatorWallTimeMs: 110,
    })
  })

  test("validates adapter inputs before they become reports", () => {
    expect(() => HarnessAdapter.Task.parse({ hiddenTestsAccessible: true })).toThrow()
  })
})
