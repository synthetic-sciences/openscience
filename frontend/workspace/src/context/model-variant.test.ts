import { describe, expect, test } from "bun:test"
import { modelVariantOptions, normalizedVariant, promptVariant } from "./model-variant"

describe("model thinking effort options", () => {
  test("puts standard first and preserves provider-native effort order", () => {
    expect(modelVariantOptions(["low", "medium", "high", "xhigh", "max"])).toEqual([
      "standard",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  test("omits standard from requests and rejects stale effort selections", () => {
    const variants = ["none", "low", "medium", "high", "xhigh", "max"]
    expect(normalizedVariant(undefined, variants)).toBe("standard")
    expect(normalizedVariant("ultra", variants)).toBe("standard")
    expect(promptVariant("standard", variants)).toBeUndefined()
    expect(promptVariant("xhigh", variants)).toBe("xhigh")
  })
})
