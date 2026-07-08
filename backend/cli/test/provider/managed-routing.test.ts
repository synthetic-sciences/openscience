import { test, expect, describe, mock } from "bun:test"

// Mock BunProc + default auth plugins so importing Provider never shells out or
// hits the network (mirrors test/provider/provider.test.ts).
mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string, _version?: string) => {
      const at = pkg.lastIndexOf("@")
      return at > 0 ? pkg.substring(0, at) : pkg
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

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Env } from "../../src/env"

function clearManagedLLMEnv() {
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
  ]) {
    Env.remove(key)
  }
}

const PROXY = "https://atlas.test/api/llm/proxy"

// ── Pure decision helpers ────────────────────────────────────────────────────

describe("Provider.managedRoutesOpenRouterOnly (pure)", () => {
  test("true only when billing.llm === 'managed'", () => {
    expect(Provider.managedRoutesOpenRouterOnly({ billing: { llm: "managed" } } as any)).toBe(true)
  })
  test("false for explicit byok", () => {
    expect(Provider.managedRoutesOpenRouterOnly({ billing: { llm: "byok" } } as any)).toBe(false)
  })
  test("false for auto-detect (unset / empty billing / null)", () => {
    expect(Provider.managedRoutesOpenRouterOnly({} as any)).toBe(false)
    expect(Provider.managedRoutesOpenRouterOnly({ billing: {} } as any)).toBe(false)
    expect(Provider.managedRoutesOpenRouterOnly({ billing: { llm: null } } as any)).toBe(false)
  })
})

describe("Provider.managedProviderAllowed (pure)", () => {
  test("OpenRouter and the hosted synsci demo are the only allowed providers", () => {
    expect(Provider.managedProviderAllowed("openrouter")).toBe(true)
    expect(Provider.managedProviderAllowed("synsci")).toBe(true)
    expect(Provider.managedProviderAllowed("synsci-hosted")).toBe(true)
  })
  test("first-party managed proxies + everything else are rejected", () => {
    for (const id of ["anthropic", "openai", "google", "openai-codex", "github-copilot", "gateway", "azure"]) {
      expect(Provider.managedProviderAllowed(id)).toBe(false)
    }
  })
})

// ── Availability filter (hermetic, catalog-backed) ───────────────────────────

describe("managed session availability", () => {
  test("managed ⇒ only OpenRouter (+ demo) load; first-party proxies are dropped", async () => {
    await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "thk_anthropic")
        Env.set("ANTHROPIC_BASE_URL", `${PROXY}/anthropic/v1`)
        Env.set("OPENAI_API_KEY", "thk_openai")
        Env.set("OPENAI_BASE_URL", `${PROXY}/openai/v1`)
        Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "thk_google")
        Env.set("GOOGLE_GENERATIVE_AI_BASE_URL", `${PROXY}/gemini/v1beta`)
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["openrouter"]).toBeDefined()
        expect(providers["openrouter"].options.baseURL).toBe(`${PROXY}/openrouter/v1`)
        expect(providers["anthropic"]).toBeUndefined()
        expect(providers["openai"]).toBeUndefined()
        expect(providers["google"]).toBeUndefined()
      },
    })
  })

  test("BYOK (managed off): anthropic keeps its public endpoint and no wallet token", async () => {
    await using tmp = await tmpdir({ config: { billing: { llm: "byok" } } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "sk-ant-byok-key")
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        const anthropic = providers["anthropic"]
        expect(anthropic).toBeDefined()
        // No Atlas proxy baseURL injected → getSDK falls back to the public
        // model.api.url; the BYOK key is the only credential.
        expect(anthropic.options.baseURL).toBeUndefined()
        expect(anthropic.options.apiKey).toBeUndefined()
        expect(anthropic.key).toBe("sk-ant-byok-key")
      },
    })
  })

  test("legacy auto-detect (thk_ present, billing.llm unset) is unchanged — proxies still load", async () => {
    await using tmp = await tmpdir({ config: {} })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "thk_anthropic")
        Env.set("ANTHROPIC_BASE_URL", `${PROXY}/anthropic/v1`)
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        // Gating is scoped to the explicit toggle: without it, nothing is dropped.
        expect(providers["anthropic"]).toBeDefined()
        expect(providers["anthropic"].options.baseURL).toBe(`${PROXY}/anthropic/v1`)
        expect(providers["openrouter"]).toBeDefined()
      },
    })
  })
})
