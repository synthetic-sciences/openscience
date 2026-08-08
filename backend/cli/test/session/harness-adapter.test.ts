import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"

const sessions = new Set<string>()
const token = "local-evaluator-capability-token-000000000000000000"

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "search", "reports"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), {
          force: true,
        }),
      ),
    ),
  )
  sessions.clear()
})

function task(sessionID: string, overrides: Partial<HarnessAdapter.Task> = {}): HarnessAdapter.Task {
  sessions.add(sessionID)
  return {
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "local-discovery-suite",
    title: "Local discovery evaluation",
    family: "biology",
    task: "Generate and verify a testable biological hypothesis",
    version: "1",
    taskID: "case-1",
    split: "validation",
    evaluator: { name: "local-evaluator", version: "1", source: "external", token },
    objective: "Produce a supported and independently checkable discovery",
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "model" },
    tools: ["read"],
    skills: [],
    packs: ["statistics", "biology"],
    budget: { steps: 20 },
    seed: 7,
    intervention: "autonomous",
    contamination: { policy: "Evaluator state stays outside the agent process", hiddenTestsAccessible: false },
    createdAt: Date.now(),
    ...overrides,
  }
}

function evaluation(contract: HarnessContract.Info): HarnessAdapter.Evaluation {
  return {
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    status: "passed",
    score: 0.8,
    metrics: { score: 0.8 },
    checks: HarnessDomain.compose(contract.packs ?? []).map((check) => ({
      id: check.id,
      status: "passed",
      blocking: check.severity === "blocking",
      evidence: [`receipt:${check.id}`],
    })),
    evidence: ["local:evaluation.json"],
    evaluatedAt: Date.now(),
  }
}

describe("generic harness adapter", () => {
  test("binds an arbitrary caller-owned evaluation identity without a bundled catalog", async () => {
    const contract = await HarnessAdapter.bind(task("adapter-generic"))
    expect(contract).toMatchObject({
      profile: "react",
      benchmark: {
        name: "local-discovery-suite",
        title: "Local discovery evaluation",
        family: "biology",
        task: "Generate and verify a testable biological hypothesis",
        evaluator: "local-evaluator",
        evaluatorSource: "external",
      },
      packs: ["statistics", "biology"],
    })
    expect(JSON.stringify(contract)).not.toContain(token)
  })

  test("uses neutral defaults and accepts caller-defined identifiers", async () => {
    const contract = await HarnessAdapter.bind(
      task("adapter-defaults", {
        benchmark: "private-suite-v3",
        title: undefined,
        family: undefined,
        task: undefined,
        packs: [],
      }),
    )
    expect(contract.benchmark).toMatchObject({
      name: "private-suite-v3",
      title: "private-suite-v3",
      family: "custom",
      task: "Produce a supported and independently checkable discovery",
    })
    expect(contract.packs).toEqual([])
  })

  test("enforces numeric budgets and routes search and simulation protocols", async () => {
    await expect(HarnessAdapter.bind(task("adapter-metric", { metric: { direction: "maximize" } }))).rejects.toThrow(
      "declare its metric name",
    )
    await expect(HarnessAdapter.bind(task("adapter-budget", { profile: "optimize" }))).rejects.toThrow(
      "candidate budget",
    )
    await expect(HarnessAdapter.bind(task("adapter-search", { search: "adaptive" }))).rejects.toThrow(
      "candidate budget",
    )
    const search = await HarnessAdapter.bind(
      task("adapter-search-routed", { search: "adaptive", budget: { steps: 20, candidates: 4 } }),
    )
    expect(search).toMatchObject({ profile: "optimize", search: HarnessContract.adaptiveSearch })
    const simulation = await HarnessAdapter.bind(
      task("adapter-simulation", {
        packs: ["statistics"],
        simulation: {
          kind: "pde",
          engine: {
            name: "solver",
            version: "1",
            commandSHA256: "a".repeat(64),
            configSHA256: "b".repeat(64),
          },
          problemSHA256: "c".repeat(64),
          reference: { kind: "analytic", identity: "closed-form", sha256: "d".repeat(64) },
          validation: {
            errorNorm: "L2",
            minLevels: 3,
            expectedOrder: 2,
            orderTolerance: 0.2,
            maxResidual: 1e-6,
            invariantTolerances: { mass: 1e-6 },
            requiredStressTests: ["timestep_sensitivity"],
          },
        },
      }),
    )
    expect(simulation.profile).toBe("numerical")
    expect(simulation.packs).toEqual(["statistics", "physics", "pde"])
  })

  test("enables adaptive search only for bounded numeric optimization", async () => {
    const adaptive = await HarnessAdapter.bind(
      task("adapter-adaptive", { profile: "optimize", budget: { steps: 20, candidates: 4 } }),
    )
    expect(adaptive.search).toEqual(HarnessContract.adaptiveSearch)

    const fixed = await HarnessAdapter.bind(
      task("adapter-static", {
        profile: "optimize",
        search: "static",
        budget: { steps: 20, candidates: 4 },
      }),
    )
    expect(fixed.search).toBeUndefined()
  })

  test("authenticates external evaluations and records their evidence", async () => {
    const contract = await HarnessAdapter.bind(task("adapter-ingest"))
    await expect(HarnessAdapter.ingest({ ...evaluation(contract), evaluatorToken: "x".repeat(48) })).rejects.toThrow(
      "capability was rejected",
    )
    expect(await HarnessEvaluation.list(contract.sessionID)).toEqual([])

    const result = await HarnessAdapter.ingest(evaluation(contract))
    expect(result.evaluation).toMatchObject({
      runID: contract.runID,
      score: 0.8,
      evaluator: { name: "local-evaluator", source: "external" },
      evidence: ["local:evaluation.json"],
    })
  })

  test("keeps a bound evaluator capability immutable", async () => {
    const input = task("adapter-immutable")
    await HarnessAdapter.bind(input)
    await expect(
      HarnessAdapter.bind({
        ...input,
        evaluator: { ...input.evaluator, token: "replacement-capability-token-0000000000000000" },
      }),
    ).rejects.toThrow("immutable once bound")
  })
})
