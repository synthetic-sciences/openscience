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
import { launchProtocol, recipeSelection } from "../fixture/harness"

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
    split: "validation",
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
    const sources = Object.values(HarnessBenchmark.catalog).map((manifest) => manifest.source.status)
    expect(sources.filter((status) => status === "official_open")).toHaveLength(20)
    expect(sources.filter((status) => status === "official_subset")).toHaveLength(1)
    expect(sources.filter((status) => status === "methodology_only")).toHaveLength(3)
    const paths = Object.values(HarnessBenchmark.catalog).flatMap((manifest) =>
      manifest.source.status === "methodology_only" ? [] : manifest.source.requiredPaths,
    )
    expect(paths).toHaveLength(127)
    const recipes = Object.values(HarnessBenchmark.catalog).map((manifest) => manifest.recipe.status)
    expect(recipes.filter((status) => status === "source_verified")).toHaveLength(16)
    expect(recipes.filter((status) => status === "pending_source_verification")).toHaveLength(0)
    expect(recipes.filter((status) => status === "blocked_upstream")).toHaveLength(5)
    expect(recipes.filter((status) => status === "not_applicable")).toHaveLength(3)
  })

  test("resolves common benchmark spellings without fuzzy guessing", () => {
    expect(HarnessBenchmark.resolve("BixBench").id).toBe("bixbench")
    expect(HarnessBenchmark.resolve("p^2").id).toBe("statistics")
    expect(HarnessBenchmark.resolve("BioMni Bench").id).toBe("biomni")
    expect(HarnessBenchmark.resolve("ResearchClawBench").id).toBe("researchclaw")
    expect(HarnessBenchmark.resolve("AstaBench").id).toBe("astabench")
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
      expect(manifest.execution).toBe("external_runner_required")
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

  test("rejects substituted official sources and public subsets posing as hidden benchmarks", async () => {
    const official = await HarnessAdapter.bind({
      ...task("mle", "adapter-official-source"),
      launch: launchProtocol("mle"),
    })
    expect(official.launch?.runner).toMatchObject({
      repository:
        HarnessBenchmark.catalog.mle.source.status === "official_open"
          ? HarnessBenchmark.catalog.mle.source.repository
          : undefined,
      revision:
        HarnessBenchmark.catalog.mle.source.status === "official_open"
          ? HarnessBenchmark.catalog.mle.source.revision
          : undefined,
    })

    const changed = launchProtocol("mle")
    changed.runner.repository = "https://example.org/substituted/mle-bench"
    await expect(
      HarnessAdapter.bind({ ...task("mle", "adapter-substituted-source"), launch: changed }),
    ).rejects.toThrow("catalog-pinned official source revision")

    await expect(
      HarnessAdapter.bind({
        ...task("genebench", "adapter-public-subset"),
        split: "held_out",
        launch: launchProtocol("genebench"),
      }),
    ).rejects.toThrow("cannot represent the 129-task hidden benchmark")
  })

  test("blocks official launches whose pinned upstream entrypoint is not runnable", async () => {
    await expect(
      HarnessAdapter.bind({
        ...task("weather", "weather-blocked"),
        split: "held_out",
        launch: launchProtocol("weather"),
      }),
    ).rejects.toThrow("blocked at scripts/evaluate.py")
    await expect(
      HarnessAdapter.bind({
        ...task("posttrain", "posttrain-blocked"),
        split: "release",
        launch: launchProtocol("posttrain"),
      }),
    ).rejects.toThrow("blocked at README.md")
    await expect(
      HarnessAdapter.bind({
        ...task("astabench", "astabench-blocked"),
        split: "held_out",
        launch: launchProtocol("astabench"),
      }),
    ).rejects.toThrow("blocked at scripts/eval_then_score.sh")
  })

  test("binds the exact native recipe driver and rejects recipe or entrypoint substitution", async () => {
    const recipe = recipeSelection("mle")
    const launch = launchProtocol("mle", recipe)
    const bound = await HarnessAdapter.bind({
      ...task("mle", "adapter-native-recipe"),
      split: "held_out",
      launch,
      recipe,
    })
    expect(bound.recipe).toMatchObject({
      recipeID: "mlebench-official-v2",
      entrypoint: "mlebench/cli.py",
      recipeSHA256: launch.runner.recipeSHA256,
      driverSHA256: launch.runner.driverSHA256,
    })

    await expect(
      HarnessAdapter.bind({
        ...task("mle", "adapter-native-recipe-missing"),
        split: "held_out",
        launch: launchProtocol("mle"),
      }),
    ).rejects.toThrow("source-verified execution recipe")

    await expect(
      HarnessAdapter.bind({
        ...task("mle", "adapter-native-recipe-substituted"),
        split: "held_out",
        launch: { ...launch, runner: { ...launch.runner, entrypoint: "environment/grading_server.py" } },
        recipe,
      }),
    ).rejects.toThrow("native driver")
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

  test("cascades candidates through declared fidelity stages before final promotion", async () => {
    const input = task("mle", "adapter-fidelity")
    input.fidelities = [
      { id: "smoke", final: false, maxWallTimeMs: 30_000 },
      { id: "official", final: true, maxWallTimeMs: 300_000 },
    ]
    const contract = await HarnessAdapter.bind(input)
    await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 3 })
    const first = await HarnessSearch.add({
      sessionID: contract.sessionID,
      parentIDs: [],
      branch: "baseline",
      proposal: "Screen a deterministic baseline before the official evaluator",
      artifact: { uri: "artifact:fidelity-baseline", sha256: "3".repeat(64) },
    })
    await expect(HarnessAdapter.ingest(evaluation(contract, first.id))).rejects.toThrow("name a fidelity stage")
    await expect(HarnessAdapter.ingest({ ...evaluation(contract, first.id), stage: "undeclared" })).rejects.toThrow(
      "not in the bound contract",
    )
    await expect(
      HarnessAdapter.ingest({
        ...evaluation(contract, first.id),
        stage: "smoke",
        usage: { wallTimeMs: 30_001 },
      }),
    ).rejects.toThrow("exceeded its wall-time budget")

    const screen = await HarnessAdapter.ingest({
      ...evaluation(contract, first.id),
      stage: "smoke",
      score: 0.6,
      metrics: { score: 0.6 },
      checks: [{ id: "smoke", status: "passed", blocking: true, evidence: ["receipt:smoke"] }],
      usage: { wallTimeMs: 10_000 },
    })
    expect(screen.search?.candidates[first.id]?.result).toMatchObject({ source: "screened", score: 0.6 })
    expect(screen.search?.bestID).toBeUndefined()
    if (!screen.search) throw new Error("Expected screening to update the candidate search")
    const recorded = await HarnessEvaluation.read(contract.sessionID, { type: "candidate", id: first.id })
    expect(recorded).not.toBeNull()
    if (!recorded) throw new Error("Expected the screening evaluation to be recorded")
    const replay = await HarnessSearch.screen({
      sessionID: contract.sessionID,
      candidateID: first.id,
      evaluation: recorded,
    })
    expect(replay.revision).toBe(screen.search.revision)
    await expect(
      HarnessSearch.screen({
        sessionID: contract.sessionID,
        candidateID: first.id,
        evaluation: HarnessEvaluation.Info.parse({ ...recorded, notes: "unrecorded mutation" }),
      }),
    ).rejects.toThrow("recorded external evaluation")
    await expect(
      HarnessSearch.add({
        sessionID: contract.sessionID,
        parentIDs: [first.id],
        branch: "premature-child",
        proposal: "Should not descend from a screened candidate",
        artifact: { uri: "artifact:premature", sha256: "4".repeat(64) },
      }),
    ).rejects.toThrow("externally verified passing parents")

    const final = await HarnessAdapter.ingest({
      ...evaluation(contract, first.id),
      stage: "official",
      usage: { wallTimeMs: 100_000 },
    })
    expect(final.search?.candidates[first.id]?.result).toMatchObject({ source: "verified", score: 0.8 })
    expect(final.search?.bestID).toBe(first.id)

    const second = await HarnessSearch.add({
      sessionID: contract.sessionID,
      parentIDs: [],
      branch: "alternative",
      proposal: "Cull a weak independent strategy after screening",
      artifact: { uri: "artifact:fidelity-alternative", sha256: "5".repeat(64) },
    })
    await expect(
      HarnessAdapter.ingest({
        ...evaluation(contract, second.id),
        stage: "official",
        usage: { wallTimeMs: 100_000 },
      }),
    ).rejects.toThrow("prior fidelity stage passes")
    await HarnessAdapter.ingest({
      ...evaluation(contract, second.id),
      stage: "smoke",
      score: 0.4,
      metrics: { score: 0.4 },
      checks: [{ id: "smoke", status: "passed", blocking: true, evidence: ["receipt:smoke"] }],
      usage: { wallTimeMs: 8_000 },
    })
    const failed = await HarnessAdapter.ingest({
      ...evaluation(contract, second.id),
      stage: "official",
      status: "failed",
      score: undefined,
      metrics: {},
      checks: [{ id: "official", status: "failed", blocking: true, evidence: ["receipt:failure"] }],
      usage: { wallTimeMs: 50_000 },
    })
    expect(failed.search?.candidates[second.id]?.result).toMatchObject({ source: "verified", status: "failed" })
    expect(failed.search?.bestID).toBe(first.id)
    expect(await HarnessEvaluation.list(contract.sessionID)).toHaveLength(4)
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
