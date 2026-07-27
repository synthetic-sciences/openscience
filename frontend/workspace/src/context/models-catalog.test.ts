import { describe, expect, test } from "bun:test"
import {
  canonicalKey,
  displayProviderForModel,
  foldedRouteMode,
  FRONTIER_MODELS,
  preferredModel,
  preferredModels,
  routableModelKey,
} from "./model-catalog"

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

  test("OpenRouter vendor slugs display under their branded provider families", () => {
    const openrouter = { id: "openrouter", name: "OpenRouter" }
    expect(displayProviderForModel(openrouter, "anthropic/claude-sonnet-5")).toEqual({
      id: "anthropic",
      name: "Anthropic",
    })
    expect(displayProviderForModel(openrouter, "openai/gpt-5.6-sol")).toEqual({ id: "openai", name: "OpenAI" })
    expect(displayProviderForModel(openrouter, "google/gemini-3.6-flash")).toEqual({ id: "google", name: "Google" })
    expect(displayProviderForModel(openrouter, "x-ai/grok-4.5")).toEqual({ id: "xai", name: "xAI" })
    expect(displayProviderForModel(openrouter, "z-ai/glm-5.2")).toEqual({ id: "zai", name: "Z.AI" })
  })

  test("logical models appear once while subscription routes remain separate", () => {
    const provider = (id: string) => ({ id, name: id })
    const models = preferredModels([
      {
        id: "anthropic/claude-sonnet-5",
        provider: provider("openrouter"),
      },
      {
        id: "openai/gpt-5.6-sol",
        provider: provider("openrouter"),
        modes: { pro: { model: "openai/gpt-5.6-sol-pro" } },
      },
      {
        id: "openai/gpt-5.6-sol-pro",
        provider: provider("openrouter"),
      },
      {
        id: "meta/muse-spark-1.1",
        provider: provider("openrouter"),
      },
      {
        id: "claude-sonnet-5",
        provider: provider("anthropic"),
      },
      {
        id: "gpt-5.6-sol",
        provider: provider("openai-codex"),
      },
    ])

    expect(models.map((model) => `${model.provider.id}/${model.id}`)).toEqual([
      "openrouter/openai/gpt-5.6-sol",
      "openrouter/meta/muse-spark-1.1",
      "anthropic/claude-sonnet-5",
      "openai-codex/gpt-5.6-sol",
    ])
  })

  test("stale direct model selections route to managed OpenRouter aliases when present", () => {
    const available = new Set([
      "openrouter:anthropic/claude-opus-4.8",
      "openrouter:anthropic/claude-sonnet-5",
      "openrouter:openai/gpt-5.6-sol",
      "openrouter:google/gemini-3.6-flash",
      "openrouter:x-ai/grok-4.5",
      "openrouter:meta/muse-spark-1.1",
    ])
    const hasModel = (model: { providerID: string; modelID: string }) =>
      available.has(`${model.providerID}:${model.modelID}`)

    expect(routableModelKey({ providerID: "anthropic", modelID: "claude-sonnet-5" }, hasModel)).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-5",
    })
    expect(routableModelKey({ providerID: "anthropic", modelID: "claude-opus-4-8" }, hasModel)).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-opus-4.8",
    })
    expect(routableModelKey({ providerID: "openai", modelID: "gpt-5.6" }, hasModel)).toEqual({
      providerID: "openrouter",
      modelID: "openai/gpt-5.6-sol",
    })
    expect(routableModelKey({ providerID: "gemini", modelID: "gemini-3.6-flash" }, hasModel)).toEqual({
      providerID: "openrouter",
      modelID: "google/gemini-3.6-flash",
    })
    expect(routableModelKey({ providerID: "xai", modelID: "grok-4.5" }, hasModel)).toEqual({
      providerID: "openrouter",
      modelID: "x-ai/grok-4.5",
    })
    expect(routableModelKey({ providerID: "meta", modelID: "muse-spark-1.1" }, hasModel)).toEqual({
      providerID: "openrouter",
      modelID: "meta/muse-spark-1.1",
    })
  })

  test("persisted losing routes resolve to the preferred model", () => {
    const provider = (id: string) => ({ id, name: id })
    const managed = { id: "anthropic/claude-sonnet-5", provider: provider("openrouter") }
    const native = { id: "claude-sonnet-5", provider: provider("anthropic") }

    for (const input of [
      [managed, native],
      [native, managed],
    ]) {
      const models = preferredModels(input)
      expect(preferredModel(models, { providerID: "openrouter", modelID: managed.id })).toEqual(native)
    }
  })

  test("stale service-route selections resolve only to a base with the matching mode", () => {
    const provider = { id: "openrouter", name: "OpenRouter" }
    const key = { providerID: "openrouter", modelID: "openai/gpt-5.6-sol-pro" }
    const base = {
      id: "openai/gpt-5.6-sol",
      provider,
      modes: { pro: { model: "openai/gpt-5.6-sol-pro" } },
    }
    const unsupported = { id: "openai/gpt-5.6-sol", provider }

    expect(preferredModel([base], key)).toBe(base)
    expect(foldedRouteMode(key, base)).toBe("pro")
    expect(preferredModel([unsupported], key)).toBeUndefined()
    expect(foldedRouteMode(key, unsupported)).toBeUndefined()
  })
})
