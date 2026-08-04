import { describe, expect, test } from "bun:test"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessReport } from "../../src/session/harness/report"

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

  test("validates adapter inputs before they become reports", () => {
    expect(() => HarnessAdapter.Task.parse({ hiddenTestsAccessible: true })).toThrow()
  })
})
