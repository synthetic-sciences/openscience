import { describe, expect, test } from "bun:test"
import { HarnessBenchmark } from "../../src/session/harness/benchmark"
import { HarnessRecipe } from "../../src/session/harness/recipe"
import { recipeSelection } from "../fixture/harness"

describe("source-verified benchmark recipes", () => {
  test("materializes one native execution contract per representative benchmark family", () => {
    const ids: HarnessRecipe.Verified[] = [
      "bixbench",
      "biomni",
      "pde",
      "chembench",
      "matscibench",
      "mle",
      "ale",
      "researchclaw",
      "paperbench",
      "scicode",
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
    expect([...families].toSorted()).toEqual(["biology", "chemistry", "generalist", "ml", "physics"])
    expect(HarnessRecipe.materialize("biomni", recipeSelection("biomni")).artifacts).toEqual([
      {
        id: "rewards",
        kind: "return",
        format: "json",
        producedBy: "evaluate",
        owner: "evaluator",
      },
    ])
  })

  test("rejects undeclared, missing, unsafe, out-of-range, and substituted bindings", () => {
    const mle = recipeSelection("mle")
    expect(() => HarnessRecipe.materialize("mle", { ...mle, recipeID: "bixbench-official-v1" })).toThrow(
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
          },
        ],
      }),
    ).toThrow("must come from a Python API stage")
  })

  test("distinguishes pending and upstream-blocked adapters instead of inventing a generic recipe", () => {
    expect(HarnessBenchmark.catalog.corebench.recipe.status).toBe("pending_source_verification")
    expect(HarnessBenchmark.catalog.statistics.recipe.status).toBe("not_applicable")
    expect(HarnessBenchmark.catalog.posttrain.recipe).toMatchObject({
      status: "blocked_upstream",
      anchor: "README.md",
    })
    expect(HarnessBenchmark.catalog.weather.recipe).toMatchObject({
      status: "blocked_upstream",
      anchor: "scripts/evaluate.py",
    })
    expect(() => HarnessRecipe.resolve("posttrain")).toThrow("No source-verified execution recipe")
    expect(() => HarnessRecipe.resolve("weather")).toThrow("No source-verified execution recipe")
  })
})
