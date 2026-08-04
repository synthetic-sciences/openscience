import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessBenchmark } from "../../src/session/harness/benchmark"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const token = "benchmark-evaluator-capability-token-0000000000000000"

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "search", "reports"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
  sessions.clear()
})

function task(benchmark: string, sessionID = `adapter-${benchmark}`): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark,
    version: "2026.08",
    taskID: "task-1",
    split: "held_out",
    evaluator: { name: "official-evaluator", version: "2", source: "benchmark", token },
    objective: "Maximize the official held-out score without seeing hidden tests",
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "model", effort: "high" },
    tools: ["read", "bash"],
    skills: [{ name: "domain-method", version: "1", sha256: "a".repeat(64) }],
    budget: { steps: 40, candidates: 3, tokens: 20_000, costUSD: 5 },
    seed: 17,
    intervention: "autonomous",
    contamination: {
      policy: "The evaluator and hidden outputs remain outside the agent process",
      hiddenTestsAccessible: false,
      publicDataCutoff: "2026-07-01",
    },
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

function evaluation(contract: HarnessContract.Info, candidateID?: string): HarnessAdapter.Evaluation {
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    candidateID,
    status: "passed",
    score: 0.8,
    metrics: { score: 0.8 },
    checks: checks(contract),
    evidence: ["official:report.json"],
    evaluatedAt: Date.now(),
  })
}

describe("benchmark adapters", () => {
  test("publishes a valid manifest for every canonical adapter", () => {
    expect(Object.keys(HarnessBenchmark.catalog).toSorted()).toEqual(HarnessBenchmark.Id.options.toSorted())
    for (const manifest of Object.values(HarnessBenchmark.catalog)) {
      expect(HarnessBenchmark.Manifest.parse(manifest)).toEqual(manifest)
      expect(HarnessBenchmark.resolve(manifest.title).id).toBe(manifest.id)
    }
  })

  test("resolves common benchmark spellings without fuzzy guessing", () => {
    expect(HarnessBenchmark.resolve("BixBench").id).toBe("bixbench")
    expect(HarnessBenchmark.resolve("p^2").id).toBe("statistics")
    expect(HarnessBenchmark.resolve("BioMni Bench").id).toBe("biomni")
    expect(HarnessBenchmark.resolve("ResearchClawBench").id).toBe("researchclaw")
    expect(() => HarnessBenchmark.resolve("imaginary-bench")).toThrow("Unsupported benchmark adapter")
  })

  test("smoke-binds every adapter with its required profile and methodology packs", async () => {
    for (const id of HarnessBenchmark.Id.options) {
      const contract = await HarnessAdapter.bind(task(id))
      const manifest = HarnessBenchmark.catalog[id]
      expect(contract.benchmark.name).toBe(id)
      expect(contract.profile).toBe(manifest.profile)
      expect(contract.packs).toEqual(manifest.packs)
      expect(contract.benchmark.evaluatorVersion).toBe("2")
      expect(contract.benchmark.evaluatorSource).toBe("benchmark")
      expect(JSON.stringify(contract)).not.toContain(token)
    }
  })

  test("rejects incompatible profiles and unbounded optimization", async () => {
    await expect(HarnessAdapter.bind({ ...task("mle", "adapter-profile"), profile: "theory" })).rejects.toThrow(
      "not valid",
    )
    const input = task("mle", "adapter-budget")
    delete input.budget.candidates
    await expect(HarnessAdapter.bind(input)).rejects.toThrow("candidate budget")
  })

  test("requires the out-of-band evaluator capability and exact bound metric", async () => {
    const contract = await HarnessAdapter.bind(task("chembench", "adapter-capability"))
    await expect(HarnessAdapter.ingest({ ...evaluation(contract), evaluatorToken: "x".repeat(48) })).rejects.toThrow(
      "capability was rejected",
    )
    await expect(HarnessAdapter.ingest({ ...evaluation(contract), metrics: { score: 0.7 } })).rejects.toThrow(
      "does not match",
    )
    expect(await HarnessEvaluation.list(contract.sessionID)).toEqual([])
  })

  test("requires every adapter-selected blocking domain check", async () => {
    const contract = await HarnessAdapter.bind(task("pde", "adapter-pde"))
    const input = evaluation(contract)
    input.checks = input.checks.filter((check) => check.id !== "pde-convergence")
    await expect(HarnessAdapter.ingest(input)).rejects.toThrow("pde-convergence:missing")
  })

  test("journals and promotes multiple candidate evaluations without overwriting", async () => {
    const contract = await HarnessAdapter.bind(task("mle", "adapter-search"))
    await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 3 })
    const first = await HarnessSearch.add({
      sessionID: contract.sessionID,
      parentIDs: [],
      branch: "seed",
      proposal: "Reproducible baseline",
      artifact: { uri: "artifact:seed", sha256: "1".repeat(64) },
    })
    const one = await HarnessAdapter.ingest(evaluation(contract, first.id))
    expect(one.search?.bestID).toBe(first.id)

    const second = await HarnessSearch.add({
      sessionID: contract.sessionID,
      parentIDs: [first.id],
      branch: "feature",
      proposal: "Leakage-safe feature change",
      artifact: { uri: "artifact:feature", sha256: "2".repeat(64) },
    })
    const improved = { ...evaluation(contract, second.id), score: 0.85, metrics: { score: 0.85 } }
    const two = await HarnessAdapter.ingest(improved)
    expect(two.search?.bestID).toBe(second.id)
    expect(await HarnessEvaluation.list(contract.sessionID)).toHaveLength(2)
    expect(await HarnessEvaluation.read(contract.sessionID, { type: "candidate", id: first.id })).toMatchObject({
      score: 0.8,
    })
    expect(await HarnessEvaluation.read(contract.sessionID, { type: "candidate", id: second.id })).toMatchObject({
      score: 0.85,
    })
    await expect(HarnessAdapter.ingest({ ...improved, score: 0.9, metrics: { score: 0.9 } })).rejects.toThrow(
      "immutable",
    )
  })

  test("keeps evaluator bindings immutable even when the contract is unchanged", async () => {
    const input = task("weather", "adapter-binding")
    await HarnessAdapter.bind(input)
    await expect(
      HarnessAdapter.bind({
        ...input,
        evaluator: { ...input.evaluator, token: "different-evaluator-capability-token-000000000000" },
      }),
    ).rejects.toThrow("immutable")
  })
})
