import { describe, expect, test } from "bun:test"
import { canonicalKey, FRONTIER_MODELS } from "./model-catalog"

describe("frontier model canonicalization", () => {
  test("direct and OpenRouter GPT-5.6 ids collapse to the same frontier keys", () => {
    for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(canonicalKey("openai", id)).toBe(canonicalKey("openrouter", `openai/${id}`))
      expect(FRONTIER_MODELS.has(canonicalKey("openai", id))).toBe(true)
    }
  })

  test("xAI and OpenRouter Grok vendor aliases dedupe", () => {
    const direct = canonicalKey("xai", "grok-4.5")
    const managed = canonicalKey("openrouter", "x-ai/grok-4.5")
    expect(direct).toBe(managed)
    expect(FRONTIER_MODELS.has(direct)).toBe(true)
  })

  test("Muse Spark is part of the default frontier set", () => {
    expect(FRONTIER_MODELS.has(canonicalKey("meta", "muse-spark-1.1"))).toBe(true)
  })
})
