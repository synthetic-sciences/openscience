import { describe, expect, test } from "bun:test"
import { HarnessBenchmark } from "../../src/session/harness/benchmark"
import { HarnessRecipe } from "../../src/session/harness/recipe"
import { recipeSelection } from "../fixture/harness"

describe("source-verified benchmark recipes", () => {
  test("materializes one native execution contract per representative benchmark family", () => {
    const ids: HarnessRecipe.Verified[] = ["bixbench", "pde", "chembench", "mle", "researchclaw"]
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
  })

  test("keeps unsupported adapters explicitly pending instead of inventing a generic recipe", () => {
    expect(HarnessBenchmark.catalog.paperbench.recipe.status).toBe("pending_source_verification")
    expect(HarnessBenchmark.catalog.statistics.recipe.status).toBe("not_applicable")
    expect(() => HarnessRecipe.resolve("paperbench")).toThrow("No source-verified execution recipe")
  })
})
