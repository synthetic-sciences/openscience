import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"

const sessions = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) => [
      fs.rm(path.join(Global.Path.data, "harness", "contracts", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "evaluations", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
    ]),
  )
  sessions.clear()
})

function contract(sessionID: string): HarnessContract.Info {
  sessions.add(sessionID)
  return {
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    objective: "Maximize the official held-out score without accessing hidden tests",
    benchmark: {
      name: "example-bench",
      title: "Example evaluation",
      family: "custom",
      task: "Produce a verified held-out result",
      version: "2026.08",
      taskID: "task-1",
      split: "held_out",
      evaluator: "official-evaluator",
      metric: "score",
      direction: "maximize",
    },
    profile: "optimize",
    model: { provider: "openai", name: "gpt-test", effort: "high" },
    tools: ["bash", "read"],
    skills: [{ name: "statistics", version: "1.0.0" }],
    budget: { wallTimeMs: 60_000, steps: 50, costUSD: 10 },
    seed: 17,
    intervention: "autonomous",
    contamination: { policy: "official", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  }
}

function evaluation(sessionID: string): HarnessEvaluation.Info {
  return {
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    evaluator: { name: "official-evaluator", version: "1.0.0", source: "benchmark" },
    status: "passed",
    score: 0.82,
    metrics: { score: 0.82 },
    checks: [{ id: "official-score", status: "passed", blocking: true, evidence: ["metric:score"] }],
    evidence: ["artifact:submission.csv"],
    evaluatedAt: Date.now(),
  }
}

describe("harness contract", () => {
  test("persists an immutable-shaped benchmark run contract", async () => {
    const input = contract("session-contract")
    await HarnessContract.bind(input)
    expect(await HarnessContract.read(input.sessionID)).toEqual(input)
    expect(HarnessContract.fingerprint(input)).toHaveLength(64)
    expect(HarnessContract.fingerprint(input)).toBe(HarnessContract.fingerprint(structuredClone(input)))
    await expect(HarnessContract.bind({ ...input, objective: "changed after binding" })).rejects.toThrow("immutable")
  })

  test("rejects a passed evaluation with a failed blocking gate", () => {
    const input = evaluation("session-invalid")
    input.checks[0]!.status = "failed"
    expect(() => HarnessEvaluation.Info.parse(input)).toThrow("non-passing blocking check")
  })

  test("records only the evaluator and run bound by the contract", async () => {
    const input = contract("session-evaluation")
    await HarnessContract.bind(input)
    const submitted = { ...evaluation(input.sessionID), recordedAt: 1 }
    const before = Date.now()
    const result = await HarnessEvaluation.record(submitted)
    expect(HarnessEvaluation.verified(result)).toBe(true)
    expect(result.recordedAt).toBeGreaterThanOrEqual(before)
    expect(await HarnessEvaluation.read(input.sessionID)).toEqual(result)
    expect(await HarnessEvaluation.record(submitted)).toEqual(result)

    const mismatch = evaluation(input.sessionID)
    mismatch.runID = "different-run"
    await expect(HarnessEvaluation.record(mismatch)).rejects.toThrow("does not match contract run")
  })

  test("pins evaluator version and source when the adapter declares them", async () => {
    const input = contract("session-evaluator-version")
    input.benchmark.evaluatorVersion = "1.0.0"
    input.benchmark.evaluatorSource = "benchmark"
    await HarnessContract.bind(input)
    await expect(
      HarnessEvaluation.record({
        ...evaluation(input.sessionID),
        evaluator: { name: "official-evaluator", version: "2.0.0", source: "benchmark" },
      }),
    ).rejects.toThrow("does not match contract evaluator version")
    await expect(
      HarnessEvaluation.record({
        ...evaluation(input.sessionID),
        evaluator: { name: "official-evaluator", version: "1.0.0", source: "external" },
      }),
    ).rejects.toThrow("does not match contract source")
  })
})
