import { describe, expect, test } from "bun:test"
import { DEFAULT_PINNED_MODELS, RECOMMENDED_MODELS, togglePinned } from "./models"

const model = (modelID: string, providerID = "anthropic") => ({ modelID, providerID })

describe("pinned models", () => {
  test("starts unpinned while keeping the requested flagship trio as recommendations", () => {
    expect(DEFAULT_PINNED_MODELS).toEqual([])
    expect(RECOMMENDED_MODELS).toEqual([
      model("gpt-5.6-sol", "openai"),
      model("claude-opus-5"),
      model("kimi-k3", "moonshotai"),
    ])
  })

  test("pins and unpins a model without duplicating it", () => {
    const pinned = togglePinned([], model("claude-opus-4-8"))
    expect(pinned).toEqual({
      models: [model("claude-opus-4-8")],
      pinned: true,
      limited: false,
    })

    expect(togglePinned(pinned.models, model("claude-opus-4-8"))).toEqual({
      models: [],
      pinned: false,
      limited: false,
    })
  })

  test("unpins a recommendation through its routed provider alias", () => {
    expect(togglePinned(RECOMMENDED_MODELS, model("anthropic/claude-opus-5", "openrouter"))).toEqual({
      models: [model("gpt-5.6-sol", "openai"), model("kimi-k3", "moonshotai")],
      pinned: false,
      limited: false,
    })
  })

  test("treats API and ChatGPT access as one pinned logical model", () => {
    expect(togglePinned([model("gpt-5.6-sol", "openai")], model("gpt-5.6-sol", "openai-codex"))).toEqual({
      models: [],
      pinned: false,
      limited: false,
    })
  })

  test("deduplicates logical routes before applying the three-model cap", () => {
    const current = [model("claude-opus-4-8"), model("gpt-5-5", "openai"), model("gpt-5-5", "openai-codex")]
    expect(togglePinned(current, model("gemini-3-6-flash", "google"))).toEqual({
      models: [model("claude-opus-4-8"), model("gpt-5-5", "openai"), model("gemini-3-6-flash", "google")],
      pinned: true,
      limited: false,
    })
  })
})
