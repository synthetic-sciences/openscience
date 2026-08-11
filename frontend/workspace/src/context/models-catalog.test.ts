import { describe, expect, test } from "bun:test"
import {
  canonicalKey,
  displayProviderForModel,
  foldedRouteMode,
  FRONTIER_MODELS,
  isChatModel,
  isFrontier,
  isUserProviderConnection,
  modelContext,
  modelSummary,
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

  test("dated Anthropic aliases collapse to their stable model ids", () => {
    expect(canonicalKey("anthropic", "claude-opus-4-5-20251101")).toBe(canonicalKey("anthropic", "claude-opus-4-5"))
    expect(canonicalKey("anthropic", "claude-sonnet-4-5-20250929")).toBe(
      canonicalKey("openrouter", "anthropic/claude-sonnet-4.5"),
    )
  })

  test("current Anthropic frontier models are reachable through native and managed routes", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5"]) {
      expect(canonicalKey("anthropic", id)).toBe(canonicalKey("openrouter", `anthropic/${id}`))
      expect(FRONTIER_MODELS.has(canonicalKey("anthropic", id))).toBe(true)
    }
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
    expect(displayProviderForModel({ id: "openai-codex", name: "OpenAI (Codex subscription)" }, "gpt-5.6-sol")).toEqual(
      {
        id: "openai",
        name: "OpenAI",
      },
    )
  })

  test("model metadata stays factual and formats advertised windows calmly", () => {
    expect(modelContext(1_050_000)).toBe("1m")
    expect(modelContext(400_000)).toBe("400k")
    expect(modelSummary({ reasoning: true, context: 1_050_000, provider: "OpenAI" })).toBe(
      "Reasoning · 1m context · OpenAI",
    )
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
      "openrouter/anthropic/claude-sonnet-5",
      "openrouter/openai/gpt-5.6-sol",
      "openrouter/openai/gpt-5.6-sol-pro",
      "openrouter/meta/muse-spark-1.1",
      "openai-codex/gpt-5.6-sol",
    ])
  })

  test("chat picker excludes output-generation models", () => {
    const provider = { id: "openrouter" }
    expect(
      isChatModel({
        id: "google/gemini-3-pro-image",
        provider,
        capabilities: { output: { text: true, image: true } },
      }),
    ).toBe(false)
    expect(
      isChatModel({
        id: "openai/gpt-5.6-sol",
        provider,
        capabilities: { output: { text: true, image: false } },
      }),
    ).toBe(true)

    for (const id of ["text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002"]) {
      expect(isChatModel({ id, provider: { id: "openai" } })).toBe(false)
    }
    expect(isChatModel({ id: "nomic-embed-text", provider: { id: "openrouter" } })).toBe(false)
  })

  test("managed OpenRouter credentials are not presented as user provider setup", () => {
    expect(isUserProviderConnection({ providerID: "openrouter", source: "config", billing: "managed" })).toBe(false)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "env", billing: null })).toBe(false)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "api", billing: "managed" })).toBe(true)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "config", billing: "byok" })).toBe(true)
    expect(isUserProviderConnection({ providerID: "anthropic", source: "env", billing: "managed" })).toBe(true)
  })

  // The backend now reports the Atlas-proxied route as source "managed", which
  // the old four-value union could not express. It is still not the reader's own
  // connection, so it stays out of the panel — including on auto-detect, where a
  // wallet route resolves without the toggle ever being set to "managed".
  test("a route the Atlas proxy carries is not the reader's own connection", () => {
    expect(isUserProviderConnection({ providerID: "openrouter", source: "managed", billing: "managed" })).toBe(false)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "managed", billing: null })).toBe(false)
    // ...unless they explicitly chose Own keys, where the panel is the point.
    expect(isUserProviderConnection({ providerID: "openrouter", source: "managed", billing: "byok" })).toBe(true)
  })

  test("stable Anthropic aliases win over dated duplicates", () => {
    const provider = { id: "anthropic" }
    const dated = { id: "claude-opus-4-5-20251101", provider }
    const stable = { id: "claude-opus-4-5", provider }
    expect(preferredModels([dated, stable])).toEqual([stable])
    expect(preferredModels([stable, dated])).toEqual([stable])
  })

  test("shows ChatGPT subscription models with Fast mode in the default picker", () => {
    for (const modelID of ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(isFrontier({ providerID: "openai-codex", modelID })).toBe(true)
    }
    expect(isFrontier({ providerID: "openai-codex", modelID: "gpt-5.4-mini" })).toBe(false)
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

  test("managed routes win logical duplicates and persisted native selections follow them", () => {
    const provider = (id: string) => ({ id, name: id })
    const managed = { id: "anthropic/claude-sonnet-5", provider: provider("openrouter") }
    const native = { id: "claude-sonnet-5", provider: provider("anthropic") }

    for (const input of [
      [managed, native],
      [native, managed],
    ]) {
      const models = preferredModels(input)
      expect(models).toEqual([managed])
      expect(preferredModel(models, { providerID: "anthropic", modelID: native.id })).toEqual(managed)
    }
  })

  test("stale fast-route selections resolve only to a base with fast mode", () => {
    const provider = { id: "openrouter", name: "OpenRouter" }
    const key = { providerID: "openrouter", modelID: "anthropic/claude-opus-5-fast" }
    const base = {
      id: "anthropic/claude-opus-5",
      provider,
      modes: { fast: { model: "anthropic/claude-opus-5-fast" } },
    }
    const unsupported = { id: "anthropic/claude-opus-5", provider }

    expect(preferredModel([base], key)).toBe(base)
    expect(foldedRouteMode(key, base)).toBe("fast")
    expect(preferredModel([unsupported], key)).toBeUndefined()
    expect(foldedRouteMode(key, unsupported)).toBeUndefined()
  })

  test("Pro routes stay as independently selectable models", () => {
    const provider = { id: "openrouter", name: "OpenRouter" }
    const base = { id: "openai/gpt-5.6-sol", provider }
    const pro = { id: "openai/gpt-5.6-sol-pro", provider }
    expect(preferredModels([base, pro])).toEqual([base, pro])
    expect(foldedRouteMode({ providerID: "openrouter", modelID: pro.id }, base)).toBeUndefined()
  })
})
