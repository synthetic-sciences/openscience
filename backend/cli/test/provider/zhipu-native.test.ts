import { describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { ModelsDev } from "../../src/provider/models"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const natives = [
  { id: "zai", name: "Z.AI", api: "https://api.z.ai/api/paas/v4" },
  { id: "zhipuai", name: "Zhipu AI", api: "https://open.bigmodel.cn/api/paas/v4" },
] as const

const catalog = (provider: (typeof natives)[number], models: ModelsDev.Provider["models"] = {}) =>
  ModelsDev.Provider.parse({
    ...provider,
    env: ["ZHIPU_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    models,
  })

describe("native Zhipu providers", () => {
  test("adds GLM-5.3-Flash to stale native catalogs with its exact API contract", () => {
    for (const provider of natives) {
      const model = Provider.fromModelsDevProvider(catalog(provider)).models["glm-5.3-flash"]
      expect(model).toMatchObject({
        id: "glm-5.3-flash",
        providerID: provider.id,
        name: "GLM-5.3-Flash",
        family: "glm",
        api: { id: "glm-5.3-flash", url: provider.api, npm: "@ai-sdk/openai-compatible" },
        release_date: "2026-08-26",
        cost: { input: 0.075, output: 0.25, cache: { read: 0.015, write: 0 } },
        limit: { context: 1_000_000, output: 131_072 },
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: true, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: { field: "reasoning_content" },
        },
      })
      expect(Object.keys(model.variants ?? {})).toEqual(["low", "high", "max"])
    }
  })

  test("keeps a newer catalog entry authoritative", () => {
    const provider = natives[0]
    const model = Provider.fromModelsDevProvider(
      catalog(provider, {
        "glm-5.3-flash": {
          id: "glm-5.3-flash",
          name: "Catalog GLM-5.3-Flash",
          release_date: "2026-08-27",
          attachment: false,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["high", "max"] }],
          temperature: true,
          tool_call: true,
          limit: { context: 1_048_576, output: 65_536 },
          modalities: { input: ["text"], output: ["text"] },
          options: {},
        },
      }),
    ).models["glm-5.3-flash"]

    expect(model.name).toBe("Catalog GLM-5.3-Flash")
    expect(model.release_date).toBe("2026-08-27")
    expect(model.limit).toEqual({ context: 1_048_576, output: 65_536 })
    expect(model.capabilities.attachment).toBe(false)
  })

  test("surfaces the native model after either provider key is saved", async () => {
    const previous = new Map(
      await Promise.all(natives.map(async (provider) => [provider.id, await Auth.get(provider.id)] as const)),
    )
    await using tmp = await tmpdir({})
    try {
      for (const provider of natives) {
        await Auth.set(provider.id, { type: "api", key: `${provider.id}-test-key` })
      }
      Provider.invalidate()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          for (const provider of natives) {
            expect(providers[provider.id]).toMatchObject({
              id: provider.id,
              source: "api",
              key: `${provider.id}-test-key`,
            })
            const model = await Provider.getModel(provider.id, "glm-5.3-flash")
            expect(model.providerID).toBe(provider.id)
            expect(model.api).toEqual({
              id: "glm-5.3-flash",
              url: provider.api,
              npm: "@ai-sdk/openai-compatible",
            })
          }
        },
      })
    } finally {
      for (const provider of natives) {
        const auth = previous.get(provider.id)
        if (auth) await Auth.set(provider.id, auth)
        if (!auth) await Auth.remove(provider.id)
      }
      Provider.invalidate()
    }
  })
})
