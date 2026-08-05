import { describe, expect, test } from "bun:test"
import { HarnessBenchmark } from "../../src/session/harness/benchmark"
import { HarnessRecipe } from "../../src/session/harness/recipe"
import { recipeSelection } from "../fixture/harness"

describe("source-verified benchmark recipes", () => {
  test("materializes one native execution contract per representative benchmark family", () => {
    const ids: HarnessRecipe.Verified[] = [
      "bixbench",
      "biomni",
      "genebench",
      "pde",
      "chembench",
      "matscibench",
      "mle",
      "ale",
      "researchclaw",
      "paperbench",
      "scienceagentbench",
      "discoverybench",
      "scicode",
      "labbench",
      "sciagentarena",
      "ainsteinbench",
    ]
    const families = new Set<string>()
    for (const id of ids) {
      const recipe = HarnessRecipe.resolve(id)
      const value = HarnessRecipe.materialize(id, recipeSelection(id))
      const launch = value.stages.find((stage) => stage.id === value.launchStage)!
      families.add(HarnessBenchmark.catalog[id].family)
      expect(recipe.maturity).toBe("source_verified")
      expect(HarnessBenchmark.catalog[id].recipe).toMatchObject({
        status: "source_verified",
        id: recipe.id,
        schemaVersion: recipe.schemaVersion,
      })
      expect(value.benchmark).toBe(id)
      expect(value.recipeSHA256).toBe(HarnessRecipe.digest(recipe))
      expect(value.driverSHA256).toBe(HarnessRecipe.digest(launch.driver))
      expect(value.entrypoint).toBe(launch.driver.entrypoint)
      expect(JSON.stringify(value)).not.toMatch(/\{[a-z][a-zA-Z0-9]*\}/)
      expect(value.metrics.length).toBeGreaterThan(0)
      expect(value.artifacts.every((artifact) => value.stages.some((stage) => stage.id === artifact.producedBy))).toBe(
        true,
      )
    }
    expect([...families].toSorted()).toEqual(["biology", "chemistry", "data", "generalist", "ml", "physics"])
    expect(HarnessRecipe.materialize("biomni", recipeSelection("biomni")).artifacts).toEqual([
      {
        id: "rewards",
        kind: "return",
        format: "json",
        producedBy: "evaluate",
        owner: "evaluator",
        value: "rewards",
      },
    ])
    const chem = HarnessRecipe.materialize("chembench", recipeSelection("chembench"))
    const evaluate = chem.stages.find((stage) => stage.id === "evaluate")!
    expect(evaluate.driver).toMatchObject({ kind: "python_api", receiver: "benchmark", kwargs: { batch_size: 8 } })
    expect(HarnessRecipe.materialize("scienceagentbench", recipeSelection("scienceagentbench")).metrics).toContainEqual(
      {
        name: "success-rate",
        artifact: "evaluations",
        selector: { kind: "jsonlpath", path: "$.success_rate" },
        direction: "maximize",
        aggregation: "mean",
      },
    )
    expect(HarnessRecipe.materialize("labbench", recipeSelection("labbench")).runtime).toContainEqual(
      expect.objectContaining({ name: "agent", kind: "python_object", owner: "runner" }),
    )
    expect(HarnessRecipe.materialize("genebench", recipeSelection("genebench")).runtime).toEqual([
      expect.objectContaining({ name: "config", kind: "json", owner: "evaluator" }),
      expect.objectContaining({ name: "submission", kind: "json", owner: "runner" }),
    ])
    expect(HarnessRecipe.materialize("sciagentarena", recipeSelection("sciagentarena")).metrics).toContainEqual(
      expect.objectContaining({ name: "strategic-success", selector: { kind: "jsonpath", path: "$.score.strategic_success" } }),
    )
    expect(HarnessRecipe.materialize("ainsteinbench", recipeSelection("ainsteinbench")).metrics).toContainEqual(
      expect.objectContaining({ name: "overall-score", selector: { kind: "jsonpath", path: "$[*].score_result.overall_score" } }),
    )
  })

  test("rejects undeclared, missing, unsafe, out-of-range, and substituted bindings", () => {
    const mle = recipeSelection("mle")
    expect(() => HarnessRecipe.materialize("mle", { ...mle, recipeID: "bixbench-official-v2" })).toThrow(
      "does not match",
    )
    expect(() => HarnessRecipe.materialize("mle", { ...mle, bindings: { ...mle.bindings, surprise: "x" } })).toThrow(
      "undeclared",
    )
    expect(() =>
      HarnessRecipe.materialize("mle", {
        ...mle,
        bindings: { ...mle.bindings, outputDir: undefined } as unknown as Record<string, string>,
      }),
    ).toThrow()
    expect(() =>
      HarnessRecipe.materialize("mle", { ...mle, bindings: { ...mle.bindings, dataDir: "/tmp/data" } }),
    ).toThrow("relative")
    expect(() =>
      HarnessRecipe.materialize("mle", { ...mle, bindings: { ...mle.bindings, dataDir: "../data" } }),
    ).toThrow("relative")
    expect(() =>
      HarnessRecipe.materialize("mle", { ...mle, bindings: { ...mle.bindings, dataDir: "fixtures\\data" } }),
    ).toThrow("POSIX")
    const science = recipeSelection("scienceagentbench")
    expect(() =>
      HarnessRecipe.materialize("scienceagentbench", {
        ...science,
        bindings: { ...science.bindings, logFile: "fixtures/scienceagentbench/evaluation.json" },
      }),
    ).toThrow("must end with .jsonl")
    const chem = recipeSelection("chembench")
    expect(() =>
      HarnessRecipe.materialize("chembench", { ...chem, bindings: { ...chem.bindings, runID: "bad id" } }),
    ).toThrow("identifier")
    expect(() =>
      HarnessRecipe.materialize("chembench", { ...chem, bindings: { ...chem.bindings, batchSize: "0" } }),
    ).toThrow("minimum")
    expect(() =>
      HarnessRecipe.materialize("chembench", { ...chem, bindings: { ...chem.bindings, batchSize: "1025" } }),
    ).toThrow("maximum")
    const pde = recipeSelection("pde")
    expect(() =>
      HarnessRecipe.materialize("pde", { ...pde, bindings: { ...pde.bindings, datasetStem: "2D_rdb_NA_NA" } }),
    ).toThrow("allowed choice")
    const matsci = recipeSelection("matscibench")
    expect(() =>
      HarnessRecipe.materialize("matscibench", {
        ...matsci,
        bindings: { ...matsci.bindings, method: "majority-vote" },
      }),
    ).toThrow("allowed choice")
    const paper = recipeSelection("paperbench")
    expect(() =>
      HarnessRecipe.materialize("paperbench", {
        ...paper,
        bindings: { ...paper.bindings, paperID: "unregistered-paper" },
      }),
    ).toThrow("allowed choice")
    const ale = recipeSelection("ale")
    expect(() =>
      HarnessRecipe.materialize("ale", {
        ...ale,
        bindings: { ...ale.bindings, judgeVersion: "209901" },
      }),
    ).toThrow("allowed choice")
    const bix = HarnessRecipe.resolve("bixbench")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...bix,
        artifacts: [
          {
            id: "evaluations",
            kind: "return",
            format: "json",
            producedBy: "postprocess",
            owner: "evaluator",
            value: "evaluations",
          },
        ],
      }),
    ).toThrow("must come from a Python API stage")
    const biomni = HarnessRecipe.resolve("biomni")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...biomni,
        stages: biomni.stages.map((stage) =>
          stage.id === "evaluate" && stage.driver.kind === "python_api"
            ? { ...stage, driver: { ...stage.driver, receiver: "missing" } }
            : stage,
        ),
      }),
    ).toThrow("references unavailable values")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...biomni,
        stages: biomni.stages.map((stage) =>
          stage.id === "load" && stage.driver.kind === "python_api"
            ? { ...stage, driver: { ...stage.driver, receiver: "rewards" } }
            : stage,
        ),
      }),
    ).toThrow("references unavailable values")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...biomni,
        artifacts: biomni.artifacts.map((artifact) =>
          artifact.kind === "return" ? { ...artifact, value: "missing" } : artifact,
        ),
      }),
    ).toThrow("must name its producer value")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...bix,
        artifacts: bix.artifacts.map((artifact) =>
          artifact.kind === "file" ? { ...artifact, cardinality: { minimum: 2, maximum: 1 } } : artifact,
        ),
      }),
    ).toThrow("minimum exceeds its maximum")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...bix,
        stages: bix.stages.map((stage, index) => (index === 0 ? { ...stage, produces: "result" } : stage)),
      }),
    ).toThrow("cannot produce a Python value")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...biomni,
        stages: biomni.stages.map((stage) => (stage.id === "evaluate" ? { ...stage, produces: "evaluator" } : stage)),
      }),
    ).toThrow("Recipe values must be unique")
    const chemRecipe = HarnessRecipe.resolve("chembench")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...chemRecipe,
        stages: chemRecipe.stages.map((stage) =>
          stage.id === "evaluate" && stage.driver.kind === "python_api"
            ? {
                ...stage,
                driver: {
                  ...stage.driver,
                  arguments: { ...stage.driver.arguments, batch_size: "modelKwargs" },
                },
              }
            : stage,
        ),
      }),
    ).toThrow("binds parameters twice")
    expect(() =>
      HarnessRecipe.Recipe.parse({
        ...bix,
        metrics: bix.metrics.map((metric) => ({ ...metric, selector: { kind: "tuple" as const, index: 0 } })),
      }),
    ).toThrow("selector is incompatible")
  })

  test("distinguishes upstream-blocked and methodology adapters instead of inventing a generic recipe", () => {
    expect(HarnessBenchmark.catalog.corebench.recipe).toMatchObject({
      status: "blocked_upstream",
      anchor: "README.md",
    })
    expect(HarnessBenchmark.catalog.statistics.recipe.status).toBe("not_applicable")
    expect(HarnessBenchmark.catalog.posttrain.recipe).toMatchObject({
      status: "blocked_upstream",
      anchor: "README.md",
    })
    expect(HarnessBenchmark.catalog.weather.recipe).toMatchObject({
      status: "blocked_upstream",
      anchor: "scripts/evaluate.py",
    })
    expect(HarnessBenchmark.catalog.critpt.recipe).toMatchObject({
      status: "blocked_upstream",
      anchor: "evaluate_all_results.py",
    })
    expect(HarnessBenchmark.catalog.sciconbench.recipe).toMatchObject({
      status: "blocked_upstream",
      anchor: "evaluate.py",
    })
    expect(() => HarnessRecipe.resolve("corebench")).toThrow("No source-verified execution recipe")
    expect(() => HarnessRecipe.resolve("critpt")).toThrow("No source-verified execution recipe")
    expect(() => HarnessRecipe.resolve("posttrain")).toThrow("No source-verified execution recipe")
    expect(() => HarnessRecipe.resolve("weather")).toThrow("No source-verified execution recipe")
    expect(() => HarnessRecipe.resolve("sciconbench")).toThrow("No source-verified execution recipe")
  })
})
