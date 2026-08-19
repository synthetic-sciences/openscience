import { describe, expect, test } from "bun:test"
import {
  canonicalKey,
  displayProviderForModel,
  foldedRouteMode,
  FRONTIER_MODELS,
  groupModelRoutes,
  isChatModel,
  isFrontier,
  isUserProviderConnection,
  modelDisplayName,
  modelContext,
  modelRouteValue,
  modelSummary,
  logicalModelKey,
  parseModelRoute,
  preferredModel,
  preferredModels,
  preservedModelRoute,
  routableModelKey,
} from "./model-catalog"

describe("frontier model canonicalization", () => {
  test("the generic GPT-5.6 API route stays exact while presentation groups it with Sol", () => {
    for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(canonicalKey("openai", id)).toBe(canonicalKey("openrouter", `openai/${id}`))
      expect(isFrontier({ providerID: "openai", modelID: id })).toBe(true)
    }
    expect(canonicalKey("openai", "gpt-5.6")).not.toBe(canonicalKey("openai", "gpt-5.6-sol"))
    expect(logicalModelKey("openai", "gpt-5.6")).toBe(logicalModelKey("openai", "gpt-5.6-sol"))
    expect(modelDisplayName("GPT-5.6", "openai", "gpt-5.6")).toBe("GPT-5.6 Sol")
    expect(modelDisplayName("GPT-5.6 Luna", "openai", "gpt-5.6-luna")).toBe("GPT-5.6 Luna")
  })

  test("keeps a selected generic exact route inside the grouped Sol choice", () => {
    const provider = { id: "openai" }
    const generic = { id: "gpt-5.6", provider }
    const sol = { id: "gpt-5.6-sol", provider }
    const chatgpt = { id: "gpt-5.6-sol", provider: { id: "openai-codex" } }
    const grouped = groupModelRoutes({
      models: [sol, generic, chatgpt],
      current: { providerID: "openai", modelID: generic.id },
    })

    expect(preferredModels([generic, sol])).toEqual([generic, sol])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.model).toBe(generic)
    expect(grouped[0]?.routes).toEqual([generic, chatgpt])
  })

  test("prefers the explicit Sol id when no existing selection needs its generic API alias", () => {
    const provider = { id: "openai" }
    const generic = { id: "gpt-5.6", provider }
    const sol = { id: "gpt-5.6-sol", provider }
    const grouped = groupModelRoutes({ models: [generic, sol] })

    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.model).toBe(sol)
    expect(grouped[0]?.routes).toEqual([sol])
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

  test("presents API and ChatGPT as one logical model while retaining exact routes", () => {
    const provider = (id: string) => ({ id, name: id })
    const api = { id: "gpt-5.6-sol", provider: provider("openai") }
    const chatgpt = { id: "gpt-5.6-sol", provider: provider("openai-codex") }
    const grouped = groupModelRoutes({
      models: [api, chatgpt],
      current: { providerID: "openai-codex", modelID: chatgpt.id },
      recent: [{ providerID: "openai", modelID: api.id }],
    })

    expect(logicalModelKey("openai-codex", chatgpt.id)).toBe(logicalModelKey("openai", api.id))
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.model).toBe(chatgpt)
    expect(grouped[0]?.routes).toEqual([chatgpt, api])
  })

  test("presents Sol, Luna, and Terra once while retaining exact API and ChatGPT routes", () => {
    const provider = (id: string) => ({ id, name: id })
    const input = [
      { id: "gpt-5.6", provider: provider("openai") },
      { id: "gpt-5.6-sol", provider: provider("openai") },
      { id: "gpt-5.6-sol", provider: provider("openai-codex") },
      { id: "gpt-5.6-luna", provider: provider("openai") },
      { id: "gpt-5.6-luna", provider: provider("openai-codex") },
      { id: "gpt-5.6-terra", provider: provider("openai") },
      { id: "gpt-5.6-terra", provider: provider("openai-codex") },
    ]
    const groups = groupModelRoutes({ models: input })

    expect(groups.map((group) => group.key)).toEqual([
      "openai/gpt-5-6-sol",
      "openai/gpt-5-6-luna",
      "openai/gpt-5-6-terra",
    ])
    expect(groups.map((group) => group.routes.map((route) => route.provider.id))).toEqual([
      ["openai", "openai-codex"],
      ["openai", "openai-codex"],
      ["openai", "openai-codex"],
    ])
    expect(modelDisplayName("GPT-5.6", groups[0]!.model.provider.id, groups[0]!.model.id)).toBe("GPT-5.6 Sol")
    expect(modelDisplayName("GPT-5.6", "openai-codex", "gpt-5.6-sol")).toBe("GPT-5.6 Sol")
  })

  test("preserves an exact access route and refuses an ambiguous route switch", () => {
    const api = { id: "gpt-5.6-luna", provider: { id: "openai" } }
    const chatgpt = { id: "gpt-5.6-luna", provider: { id: "openai-codex" } }
    const routes = [api, chatgpt]

    expect(preservedModelRoute(routes, { providerID: "openai-codex", modelID: "gpt-5.6-sol" })).toBe(chatgpt)
    expect(preservedModelRoute(routes, { providerID: "anthropic", modelID: "claude-opus-5" })).toBeUndefined()
    expect(preservedModelRoute([api], { providerID: "anthropic", modelID: "claude-opus-5" })).toBe(api)
    expect(modelRouteValue({ providerID: "openrouter", modelID: "openai/gpt-5.6-luna" })).toBe(
      "openrouter/openai/gpt-5.6-luna",
    )
    expect(parseModelRoute("openrouter/openai/gpt-5.6-luna")).toEqual({
      providerID: "openrouter",
      modelID: "openai/gpt-5.6-luna",
    })
    expect(parseModelRoute("not-a-route")).toBeUndefined()
  })

  test("uses the recent exact route when the logical model is not current", () => {
    const provider = (id: string) => ({ id, name: id })
    const api = { id: "gpt-5.6-terra", provider: provider("openai") }
    const chatgpt = { id: "gpt-5.6-terra", provider: provider("openai-codex") }
    const grouped = groupModelRoutes({
      models: [api, chatgpt],
      recent: [{ providerID: "openai-codex", modelID: chatgpt.id }],
    })

    expect(grouped[0]?.model).toBe(chatgpt)
    expect(grouped[0]?.routes.map((route) => route.provider.id)).toEqual(["openai-codex", "openai"])
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

  test("only saved or dashboard-synced credentials are presented as connections", () => {
    expect(isUserProviderConnection({ providerID: "openrouter", source: "config", billing: "managed" })).toBe(false)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "env", billing: null })).toBe(false)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "api", billing: "managed" })).toBe(true)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "synced", billing: "byok" })).toBe(true)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "config", billing: "byok" })).toBe(false)
    expect(isUserProviderConnection({ providerID: "anthropic", source: "env", billing: "managed" })).toBe(false)
  })

  // The backend now reports the Atlas-proxied route as source "managed", which
  // the old four-value union could not express. It is still not the reader's own
  // connection, so it stays out of the panel — including on auto-detect, where a
  // wallet route resolves without the toggle ever being set to "managed".
  test("a route the Atlas proxy carries is not the reader's own connection", () => {
    expect(isUserProviderConnection({ providerID: "openrouter", source: "managed", billing: "managed" })).toBe(false)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "managed", billing: null })).toBe(false)
    expect(isUserProviderConnection({ providerID: "openrouter", source: "managed", billing: "byok" })).toBe(false)
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
