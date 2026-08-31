import { describe, expect, test } from "bun:test"
import { modelVariantDefault, modelVariantOptions, normalizedVariant, promptVariant } from "./model-variant"

describe("model thinking effort options", () => {
  test("distinguishes an unspecified provider default from explicit effort levels", () => {
    expect(modelVariantOptions(["low", "medium", "high", "xhigh", "max"])).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  test("omits provider default from requests and rejects stale effort selections", () => {
    const variants = ["none", "low", "medium", "high", "xhigh", "max"]
    expect(normalizedVariant(undefined, variants)).toBe("default")
    expect(normalizedVariant("ultra", variants)).toBe("default")
    expect(promptVariant("standard", variants)).toBeUndefined()
    expect(promptVariant("xhigh", variants)).toBe("xhigh")
    expect(promptVariant("none", variants)).toBe("none")
  })

  test("Grok shows exactly its four native levels and defaults to high", () => {
    const variants = ["low", "medium", "high", "xhigh"]
    const fallback = modelVariantDefault({ id: "x-ai/grok-4.6" })
    expect(modelVariantOptions(variants, fallback)).toEqual(variants)
    expect(normalizedVariant("standard", variants, fallback)).toBe("high")
    expect(promptVariant("none", variants, fallback)).toBe("high")
    expect(promptVariant("max", variants, fallback)).toBe("high")
  })

  test("honors route-specific defaults and does not invent controls for fixed models", () => {
    expect(modelVariantDefault({ id: "deepseek/deepseek-v4-pro" })).toBe("high")
    expect(modelVariantDefault({ id: "z-ai/glm-5.3" })).toBe("max")
    expect(
      modelVariantDefault({ id: "openai/gpt-5.6-sol", reasoningOptions: [{ type: "effort", default: "medium" }] }),
    ).toBe("medium")
    expect(modelVariantOptions([])).toEqual([])
    expect(promptVariant("high", [])).toBeUndefined()
  })
})
