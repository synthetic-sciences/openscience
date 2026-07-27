import { describe, expect, test } from "bun:test"
import { modelTierOptions, normalizedTier, promptTier, resolvedTier } from "./model-tier"

describe("model tier controls", () => {
  test("shows standard followed by only the selected model's real modes", () => {
    expect(modelTierOptions(["fast", "pro"]).map((x) => x.id)).toEqual(["standard", "fast", "pro"])
    expect(modelTierOptions(["standard", "fast"]).map((x) => x.id)).toEqual(["standard", "fast"])
  })

  test("does not invent modes and drops stale selections at the request boundary", () => {
    expect(modelTierOptions([])).toEqual([])
    expect(modelTierOptions(["fast"]).map((x) => x.id)).toEqual(["standard", "fast"])
    expect(normalizedTier("ultra", ["fast"])).toBe("standard")
    expect(promptTier("standard", ["fast"])).toBeUndefined()
    expect(promptTier("fast", ["fast"])).toBe("fast")
    expect(promptTier("pro", ["fast"])).toBeUndefined()
  })

  test("migrates a folded service route while preserving an explicit standard choice", () => {
    const migrated = resolvedTier(undefined, ["pro"], "pro")
    expect(migrated).toBe("pro")
    expect(promptTier(migrated, ["pro"])).toBe("pro")
    expect(resolvedTier("standard", ["pro"], "pro")).toBe("standard")
  })
})
