import { test, expect, mock } from "bun:test"
import path from "path"

// === Mocks ===
// These mocks prevent real package installations during tests

mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string, _version?: string) => {
      // Return package name without version for mocking
      const lastAtIndex = pkg.lastIndexOf("@")
      return lastAtIndex > 0 ? pkg.substring(0, lastAtIndex) : pkg
    },
    run: async () => {
      throw new Error("BunProc.run should not be called in tests")
    },
    which: () => process.execPath,
    InstallFailedError: class extends Error {},
  },
}))

const mockPlugin = () => ({})
mock.module("openscience-copilot-auth", () => ({ default: mockPlugin }))
mock.module("openscience-anthropic-auth", () => ({ default: mockPlugin }))
mock.module("@gitlab/openscience-gitlab-auth", () => ({ default: mockPlugin }))

// Import after mocks are set up
const { tmpdir } = await import("../fixture/fixture")
const { Instance } = await import("../../src/project/instance")
const { Provider } = await import("../../src/provider/provider")
const { Env } = await import("../../src/env")

function writeConfig(dir: string, extra: Record<string, any>) {
  return Bun.write(
    path.join(dir, "openscience.json"),
    JSON.stringify({
      $schema: "https://syntheticsciences.ai/config.json",
      ...extra,
    }),
  )
}

/** Exercise resolution inside a project instance whose env is reset first. */
function within(directory: string, init: () => Promise<void>, fn: () => Promise<void>) {
  return Instance.provide({
    directory,
    init: async () => {
      Env.set("DEEPSEEK_API_KEY", "")
      Env.set("DEEPSEEK_BASE_URL", "")
      Env.set("OPENROUTER_API_KEY", "")
      await init()
    },
    fn,
  })
}

test("deepseek provider resolves the native @ai-sdk/deepseek adapter", async () => {
  await using tmp = await tmpdir({ init: (dir) => writeConfig(dir, {}) })
  await within(
    tmp.path,
    async () => Env.set("DEEPSEEK_API_KEY", "sk-test-deepseek"),
    async () => {
      const providers = await Provider.list()
      const deepseek = providers["deepseek"]
      expect(deepseek).toBeDefined()
      // Native adapter wins over the catalog's generic openai-compatible entry.
      expect(deepseek.models["deepseek-v4-flash"].api.npm).toBe("@ai-sdk/deepseek")
      expect(deepseek.models["deepseek-v4-flash"].api.url).toBe("https://api.deepseek.com")
      // The loader pins the public endpoint when no DEEPSEEK_BASE_URL is set.
      expect(deepseek.options.baseURL).toBe("https://api.deepseek.com")
    },
  )
})

test("deepseek provider honors DEEPSEEK_BASE_URL", async () => {
  await using tmp = await tmpdir({ init: (dir) => writeConfig(dir, {}) })
  await within(
    tmp.path,
    async () => {
      Env.set("DEEPSEEK_API_KEY", "sk-test-deepseek")
      Env.set("DEEPSEEK_BASE_URL", "https://deepseek.example.internal")
    },
    async () => {
      const providers = await Provider.list()
      // The catalog keeps api.url fixed at the official endpoint; the loader
      // applies DEEPSEEK_BASE_URL through the provider options instead.
      expect(providers["deepseek"].options.baseURL).toBe("https://deepseek.example.internal")
    },
  )
})

test("configured deepseek model resolves through the direct provider", async () => {
  await using tmp = await tmpdir({
    init: (dir) => writeConfig(dir, { model: "deepseek/deepseek-v4-flash" }),
  })
  await within(
    tmp.path,
    async () => Env.set("DEEPSEEK_API_KEY", "sk-test-deepseek"),
    async () => {
      const model = await Provider.defaultModel()
      expect(model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-flash" })
    },
  )
})

test("an OpenRouter deepseek slug prefers the direct BYOK provider when its key is present", async () => {
  await using tmp = await tmpdir({
    init: (dir) => writeConfig(dir, { model: "openrouter/deepseek/deepseek-v4-flash" }),
  })
  await within(
    tmp.path,
    async () => {
      Env.set("OPENROUTER_API_KEY", "sk-or-test")
      Env.set("DEEPSEEK_API_KEY", "sk-test-deepseek")
    },
    async () => {
      const model = await Provider.defaultModel()
      expect(model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-flash" })
    },
  )
})

test("an OpenRouter deepseek slug stays on OpenRouter when no direct key is present", async () => {
  await using tmp = await tmpdir({
    init: (dir) => writeConfig(dir, { model: "openrouter/deepseek/deepseek-v4-flash" }),
  })
  await within(
    tmp.path,
    async () => Env.set("OPENROUTER_API_KEY", "sk-or-test"),
    async () => {
      const model = await Provider.defaultModel()
      expect(model).toEqual({ providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" })
    },
  )
})

test("a configured small_model OpenRouter slug routes to the direct deepseek provider", async () => {
  await using tmp = await tmpdir({
    init: (dir) => writeConfig(dir, { small_model: "openrouter/deepseek/deepseek-v4-flash" }),
  })
  await within(
    tmp.path,
    async () => {
      Env.set("OPENROUTER_API_KEY", "sk-or-test")
      Env.set("DEEPSEEK_API_KEY", "sk-test-deepseek")
    },
    async () => {
      const model = await Provider.getSmallModel("deepseek")
      expect(model?.providerID).toBe("deepseek")
      expect(model?.id).toBe("deepseek-v4-flash")
    },
  )
})

test("an unauthenticated catalog deepseek entry never shadows a working OpenRouter route", async () => {
  await using tmp = await tmpdir({
    init: (dir) => writeConfig(dir, { model: "openrouter/deepseek/deepseek-v4-flash" }),
  })
  await within(
    tmp.path,
    async () => Env.set("OPENROUTER_API_KEY", "sk-or-test"),
    async () => {
      // No DEEPSEEK_API_KEY, no config deepseek block — the direct provider must
      // not exist, so resolution stays on OpenRouter.
      const providers = await Provider.list()
      expect(providers["deepseek"]).toBeUndefined()
      const model = await Provider.defaultModel()
      expect(model).toEqual({ providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash" })
    },
  )
})
