import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { Global } from "../../src/global"
import { HarnessAblation } from "../../src/session/harness/ablation"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessLaunch } from "../../src/session/harness/launch"
import { launchProtocol, launchReady } from "../fixture/harness"

const sessions = new Set<string>()
const plans = new Set<string>()
const token = "ablation-evaluator-capability-token-0000000000000000"
const auditor = "ablation-auditor-capability-token-00000000000000000"
const reviewer = "ablation-semantic-capability-token-0000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "launches", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await Promise.all(
    [...plans].map((planID) =>
      fs.rm(path.join(Global.Path.data, "harness", "ablations", `${planID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  plans.clear()
})

async function run(input: {
  prefix: string
  seed: number
  role: "baseline" | "arm"
  createdAt: number
  model?: string
  direction?: "maximize" | "minimize"
  factor?: "orchestration" | "search" | "evaluator_audit" | "semantic_audit"
}) {
  const sessionID = `${input.prefix}-${input.seed}-${input.role}`
  sessions.add(sessionID)
  const contract = await HarnessAdapter.bind({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "matched-ablation-task",
    split: "held_out",
    evaluator: { name: "official-ablation-evaluator", version: "3", source: "benchmark", token },
    objective: "Measure the isolated effect of conditional orchestration",
    profile: input.factor === "search" ? "optimize" : undefined,
    search: input.factor === "search" ? (input.role === "arm" ? "adaptive" : "static") : undefined,
    launch: launchProtocol("ablation"),
    orchestration:
      input.role === "arm" && input.factor === "orchestration"
        ? { topology: "solo", maxWorkers: 1, maxRounds: 1, minIndependentVerifiers: 1 }
        : undefined,
    evaluatorAudit:
      input.role === "arm" && input.factor === "evaluator_audit"
        ? {
            token: auditor,
            protocol: {
              protocolVersion: "evaluator-audit-v1",
              auditor: { name: "ablation-meta-evaluator", version: "1", source: "external" },
              suite: { name: "ablation-suite", version: "1", commitmentSHA256: hash("ablation-suite") },
              minCleanCases: 2,
              minCasesPerFault: 1,
              requiredFaults: ["wrong_answer"],
              minSensitivity: 0.8,
              minSpecificity: 0.8,
              minBalancedAccuracy: 0.8,
              minFaultRecall: 0.8,
              maxBrierScore: 0.15,
            },
          }
        : undefined,
    semanticAudit:
      input.role === "arm" && input.factor === "semantic_audit"
        ? {
            token: reviewer,
            protocol: {
              protocolVersion: "semantic-audit-v1",
              reviewer: { name: "ablation-meaning-review", version: "1", source: "external" },
              scope: {
                objectiveSHA256: hash("Measure the isolated effect of conditional orchestration"),
                criteria: [{ id: "intent", requirement: "Answer the intended scientific problem" }],
                forbiddenShortcuts: [{ id: "vacuity", description: "Do not satisfy only a vacuous interpretation" }],
                literature: { cutoff: "2026-08-01", corpusSHA256: hash("ablation-literature") },
                noveltyFloor: "not_required",
              },
              minReviewers: 2,
              minConfidence: 0.8,
            },
          }
        : undefined,
    metric: { name: "score", direction: input.direction ?? "maximize" },
    model: { provider: "test", name: input.model ?? "model" },
    tools: ["read", "bash"],
    skills: [],
    budget: {
      steps: 30,
      tokens: 20_000,
      costUSD: 2,
      ...(input.factor === "search" ? { candidates: 8 } : {}),
    },
    seed: input.seed,
    intervention: "autonomous",
    contamination: { policy: "hidden outcomes remain evaluator-private", hiddenTestsAccessible: false },
    createdAt: input.createdAt,
  })
  await launchReady(contract, token)
  return contract
}

async function study(
  prefix: string,
  drift = false,
  direction: "maximize" | "minimize" = "maximize",
  factor: "orchestration" | "search" | "evaluator_audit" | "semantic_audit" = "orchestration",
) {
  const createdAt = Date.now()
  const pairs = await Promise.all(
    [1, 2, 3].map(async (seed) => ({
      baseline: await run({ prefix, seed, role: "baseline", createdAt, direction, factor }),
      arm: await run({
        prefix,
        seed,
        role: "arm",
        createdAt,
        direction,
        factor,
        model: drift && seed === 2 ? "different-model" : undefined,
      }),
    })),
  )
  const plan = {
    schemaVersion: 1 as const,
    studyID: `${prefix}-study`,
    factor: { kind: factor },
    minEffect: 0.05,
    maxPairRegression: 0,
    pairs: pairs.map((pair) => ({
      baseline: { sessionID: pair.baseline.sessionID, evaluatorToken: token },
      arm: { sessionID: pair.arm.sessionID, evaluatorToken: token },
    })),
  }
  const credentials = pairs.flatMap((pair) => [
    { sessionID: pair.baseline.sessionID, evaluatorToken: token },
    { sessionID: pair.arm.sessionID, evaluatorToken: token },
  ])
  return { pairs, plan, credentials }
}

async function evaluate(contract: HarnessContract.Info, score: number, evaluatedAt: number) {
  const launch = await HarnessLaunch.ready(contract)
  const checks = HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`receipt:${check.id}`],
  }))
  return HarnessAdapter.ingest({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    launchReceiptID: launch?.receiptID,
    status: "passed",
    score,
    metrics: { score },
    checks,
    evidence: ["official:ablation-result.json"],
    evaluatedAt,
  })
}

async function fail(contract: HarnessContract.Info) {
  const checks = HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "failed" as const,
    blocking: check.severity === "blocking",
    evidence: [`receipt:${check.id}`],
  }))
  return HarnessAdapter.ingest({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    status: "failed",
    metrics: {},
    checks,
    evidence: ["official:ablation-failure.json"],
    evaluatedAt: Date.now(),
  })
}

describe("matched scientific ablations", () => {
  test("freezes seed-paired contracts before evaluation and derives supported effects", async () => {
    const input = await study("ablation-supported")
    const app = HarnessRoutes()
    const initialized = await app.request("/ablations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.plan),
    })
    expect(initialized.status).toBe(200)
    const state = (await initialized.json()) as HarnessAblation.State
    plans.add(state.plan.planID)
    expect(state.plan.pairs.map((pair) => pair.seed)).toEqual([1, 2, 3])
    expect(state.plan.baselineValueSHA256).not.toBe(state.plan.armValueSHA256)
    expect(JSON.stringify(state)).not.toContain(token)

    const effects = [0.1, 0.11, 0.09]
    await Promise.all(
      input.pairs.flatMap((pair, index) => [
        evaluate(pair.baseline, 0.7, Date.now()),
        evaluate(pair.arm, 0.7 + effects[index]!, Date.now()),
      ]),
    )
    const assessed = await app.request(`/ablations/${state.plan.planID}/assessment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runs: input.credentials }),
    })
    expect(assessed.status).toBe(200)
    const result = (await assessed.json()) as HarnessAblation.State
    expect(result.receipt).toMatchObject({
      verdict: "supported",
      statistics: { pairs: 3, validPairs: 3, regressions: 0 },
    })
    expect(result.receipt?.statistics.meanEffect).toBeCloseTo(0.1)
    expect(result.receipt?.statistics.confidence95?.[0]).toBeGreaterThan(0.05)
    expect(result.receipt?.pairs.map((pair) => pair.effect)).toEqual([
      0.09999999999999998, 0.10999999999999999, 0.08999999999999997,
    ])
  })

  test("rejects an arm with model drift outside the declared factor", async () => {
    const input = await study("ablation-drift", true)
    await expect(HarnessAblation.initialize(input.plan)).rejects.toThrow("differs outside the declared factor")
  })

  test("isolates evaluator qualification as its own ablatable protocol factor", async () => {
    const input = await study("ablation-evaluator-audit", false, "maximize", "evaluator_audit")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    expect(initialized.plan.factor.kind).toBe("evaluator_audit")
    expect(initialized.plan.baselineValueSHA256).not.toBe(initialized.plan.armValueSHA256)
  })

  test("isolates semantic meaning review as its own ablatable protocol factor", async () => {
    const input = await study("ablation-semantic-audit", false, "maximize", "semantic_audit")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    expect(initialized.plan.factor.kind).toBe("semantic_audit")
    expect(initialized.plan.baselineValueSHA256).not.toBe(initialized.plan.armValueSHA256)
  })

  test("isolates the adaptive search controller from the static leased baseline", async () => {
    const input = await study("ablation-search", false, "maximize", "search")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    expect(initialized.plan.factor.kind).toBe("search")
    expect(
      input.pairs.every((pair) => !pair.baseline.search && pair.arm.search?.protocolVersion === "adaptive-search-v1"),
    ).toBe(true)
    expect(initialized.plan.baselineValueSHA256).not.toBe(initialized.plan.armValueSHA256)
  })

  test("requires predeclaration before any paired outcome is visible", async () => {
    const input = await study("ablation-late")
    await evaluate(input.pairs[0]!.baseline, 0.7, Date.now())
    await expect(HarnessAblation.initialize(input.plan)).rejects.toThrow("before any paired evaluation")
  })

  test("rejects a precisely measured effect below the practical threshold", async () => {
    const input = await study("ablation-null")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    await Promise.all(
      input.pairs.flatMap((pair) => [evaluate(pair.baseline, 0.7, Date.now()), evaluate(pair.arm, 0.7, Date.now())]),
    )
    const result = await HarnessAblation.assess(initialized.plan.planID, {
      runs: input.credentials,
    })
    expect(result?.receipt).toMatchObject({
      verdict: "rejected",
      statistics: { meanEffect: 0, confidence95: [0, 0], minEffect: 0.05 },
    })
  })

  test("reverses paired effects for a metric that is minimized", async () => {
    const input = await study("ablation-minimize", false, "minimize")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    await Promise.all(
      input.pairs.flatMap((pair, index) => [
        evaluate(pair.baseline, 1, Date.now()),
        evaluate(pair.arm, 0.9 - index * 0.01, Date.now()),
      ]),
    )
    const result = await HarnessAblation.assess(initialized.plan.planID, { runs: input.credentials })
    expect(result?.receipt).toMatchObject({ verdict: "supported", statistics: { regressions: 0 } })
    expect(result?.receipt?.statistics.meanEffect).toBeCloseTo(0.11)
  })

  test("rejects an average gain when one seed exceeds the regression tolerance", async () => {
    const input = await study("ablation-regression")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    const effects = [0.4, 0.4, -0.01]
    await Promise.all(
      input.pairs.flatMap((pair, index) => [
        evaluate(pair.baseline, 0.5, Date.now()),
        evaluate(pair.arm, 0.5 + effects[index]!, Date.now()),
      ]),
    )
    const result = await HarnessAblation.assess(initialized.plan.planID, { runs: input.credentials })
    expect(result?.receipt).toMatchObject({
      verdict: "rejected",
      statistics: { regressions: 1, maxPairRegression: 0 },
    })
  })

  test("records failed evaluator outcomes as rejected rather than usable effects", async () => {
    const input = await study("ablation-failure")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    await Promise.all(
      input.pairs.flatMap((pair, index) => [
        evaluate(pair.baseline, 0.7, Date.now()),
        index === 1 ? fail(pair.arm) : evaluate(pair.arm, 0.8, Date.now()),
      ]),
    )
    const result = await HarnessAblation.assess(initialized.plan.planID, { runs: input.credentials })
    expect(result?.receipt).toMatchObject({
      verdict: "rejected",
      statistics: { pairs: 3, validPairs: 2 },
    })
    expect(result?.receipt?.pairs[1]).toMatchObject({ arm: { status: "failed" } })
    expect(result?.receipt?.pairs[1]?.effect).toBeUndefined()
  })

  test("fails closed when persisted plan content is corrupted", async () => {
    const input = await study("ablation-tamper")
    const initialized = await HarnessAblation.initialize(input.plan)
    if (!initialized) throw new Error("Expected an initialized ablation")
    plans.add(initialized.plan.planID)
    const target = path.join(Global.Path.data, "harness", "ablations", `${initialized.plan.planID}.json`)
    const state = JSON.parse(await Bun.file(target).text()) as HarnessAblation.State
    await Bun.write(target, JSON.stringify({ ...state, plan: { ...state.plan, minEffect: 0 } }))
    expect(await HarnessAblation.read(initialized.plan.planID)).toBeNull()
    await expect(HarnessAblation.assess(initialized.plan.planID, { runs: input.credentials })).rejects.toThrow(
      "Unknown ablation plan",
    )
  })
})
