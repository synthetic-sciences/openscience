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
import { Inference } from "../../src/provider/inference"
import { Env } from "../../src/env"
import { Auth } from "../../src/auth"
import { API_BASE } from "../../src/openscience"

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
    "META_MODEL_API_KEY",
    "META_MODEL_BASE_URL",
  ]) {
    Env.remove(key)
  }
}

const PROXY = `${API_BASE}/api/llm/proxy`

// ── Pure decision helpers ────────────────────────────────────────────────────

describe("Provider.managedRoutesCuratedProvidersOnly (pure)", () => {
  test("true only when billing.llm === 'managed'", () => {
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: { llm: "managed" } } as any)).toBe(true)
  })
  test("false for explicit byok", () => {
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: { llm: "byok" } } as any)).toBe(false)
  })
  test("false for auto-detect (unset / empty billing / null)", () => {
    expect(Provider.managedRoutesCuratedProvidersOnly({} as any)).toBe(false)
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: {} } as any)).toBe(false)
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: { llm: null } } as any)).toBe(false)
  })
})

describe("Provider.managedProviderAllowed (pure)", () => {
  test("OpenRouter and the hosted synsci demo are the only managed providers", () => {
    expect(Provider.managedProviderAllowed("openrouter")).toBe(true)
    expect(Provider.managedProviderAllowed("synsci")).toBe(true)
    expect(Provider.managedProviderAllowed("synsci-hosted")).toBe(true)
  })
  test("first-party managed proxies, Meta, Codex, and everything else are rejected", () => {
    for (const id of ["anthropic", "openai", "google", "meta", "openai-codex", "github-copilot", "gateway", "azure"]) {
      expect(Provider.managedProviderAllowed(id)).toBe(false)
    }
  })
})

describe("Provider.isAtlasProxyBaseURL (pure)", () => {
  test("accepts only current first-party proxy routes", () => {
    expect(Provider.isAtlasProxyBaseURL(`${PROXY}/openrouter/v1`)).toBe(true)
    expect(Provider.isAtlasProxyBaseURL(`${PROXY}/openrouter/v1/chat/completions`)).toBe(true)
  })

  test("rejects lookalike origins and path/query tricks", () => {
    expect(Provider.isAtlasProxyBaseURL("https://evil.test/api/llm/proxy/openrouter/v1")).toBe(false)
    expect(Provider.isAtlasProxyBaseURL(`${API_BASE}/not-api/llm/proxy/openrouter/v1`)).toBe(false)
    expect(Provider.isAtlasProxyBaseURL(`${PROXY}/openrouter/v1?next=https://evil.test`)).toBe(false)
    expect(Provider.isAtlasProxyBaseURL(`not a url`)).toBe(false)
  })
})

describe("Provider.isManagedProxyBaseURL (pure)", () => {
  test("detects proxy-shaped routes for BYOK leak prevention", () => {
    expect(Provider.isManagedProxyBaseURL(`${PROXY}/openrouter/v1`)).toBe(true)
    expect(Provider.isManagedProxyBaseURL("https://legacy.example/api/llm/proxy/openrouter/v1")).toBe(true)
    expect(Provider.isManagedProxyBaseURL("https://openrouter.ai/api/v1")).toBe(false)
    expect(Provider.isManagedProxyBaseURL(`${PROXY}/openrouter/v1?key=value`)).toBe(false)
  })
})

// ── Availability filter (hermetic, catalog-backed) ───────────────────────────

describe("managed session availability", () => {
  test("managed ⇒ only OpenRouter loads; unsupported first-party and Meta proxies are dropped", async () => {
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
        Env.set("META_MODEL_API_KEY", "thk_meta")
        Env.set("META_MODEL_BASE_URL", `${PROXY}/meta/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["openrouter"]).toBeDefined()
        expect(providers["openrouter"].options.baseURL).toBe(`${PROXY}/openrouter/v1`)
        expect(providers["meta"]).toBeUndefined()
        expect(providers["anthropic"]).toBeUndefined()
        expect(providers["openai"]).toBeUndefined()
        expect(providers["google"]).toBeUndefined()
      },
    })
  })

  test("managed direct model selections resolve to OpenRouter vendor slugs", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["anthropic/claude-sonnet-5", "google/gemini-3.6-flash", "x-ai/grok-4.5", "meta/muse-spark-1.1"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const sonnet = await Provider.getModel("anthropic", "claude-sonnet-5")
        expect(sonnet.providerID).toBe("openrouter")
        expect(sonnet.id).toBe("anthropic/claude-sonnet-5")

        const gemini = await Provider.getModel("gemini", "gemini-3.6-flash")
        expect(gemini.providerID).toBe("openrouter")
        expect(gemini.id).toBe("google/gemini-3.6-flash")

        const grok = await Provider.getModel("xai", "grok-4.5")
        expect(grok.providerID).toBe("openrouter")
        expect(grok.id).toBe("x-ai/grok-4.5")

        const muse = await Provider.getModel("meta", "muse-spark-1.1")
        expect(muse.providerID).toBe("openrouter")
        expect(muse.id).toBe("meta/muse-spark-1.1")
      },
    })
  })

  test("managed OpenRouter self-heals a key-only synced env snapshot", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["anthropic/claude-sonnet-4.6"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        const openrouter = providers["openrouter"]
        expect(openrouter).toBeDefined()
        expect(openrouter.options.apiKey).toStartWith("thk_")
        expect(openrouter.options.baseURL).toBe(`${PROXY}/openrouter/v1`)

        const model = await Provider.getModel("openrouter", "anthropic/claude-sonnet-4.6")
        await expect(Provider.getLanguage(model)).resolves.toBeDefined()
      },
    })
  })

  test("Fable is hidden from stale managed and direct catalogs", async () => {
    await using managed = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["anthropic/claude-fable-5", "anthropic/claude-sonnet-5"],
          },
        },
      },
    })
    await Instance.provide({
      directory: managed.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter.models["anthropic/claude-fable-5"]).toBeUndefined()
        expect(openrouter.models["anthropic/claude-sonnet-5"]).toBeDefined()
        await expect(Provider.getModel("openrouter", "anthropic/claude-fable-5")).rejects.toThrow()
        await expect(Provider.getModel("amazon-bedrock", "anthropic.claude-fable-5")).rejects.toThrow()
        await expect(Provider.getModel("amazon-bedrock", "global.anthropic.claude-fable-5")).rejects.toThrow()
        await expect(Provider.getModel("digitalocean", "anthropic-claude-fable-5")).rejects.toThrow()
        await expect(Provider.getModel("gitlab", "duo-chat-fable-5")).rejects.toThrow()
      },
    })

    await using byok = await tmpdir({ config: { billing: { llm: "byok" } } })
    await Instance.provide({
      directory: byok.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "sk-ant-byok-key")
        Provider.invalidate()
      },
      fn: async () => {
        const anthropic = (await Provider.list())["anthropic"]
        expect(anthropic).toBeDefined()
        expect(anthropic.models["claude-fable-5"]).toBeUndefined()
        expect(anthropic.models["claude-sonnet-5"]).toBeDefined()
      },
    })
  })

  test("unhealthy managed OpenRouter slugs are hidden from stale synced catalogs", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["mistralai/mistral-small-3.2-24b-instruct", "mistralai/mistral-medium-3.1"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter.models["mistralai/mistral-small-3.2-24b-instruct"]).toBeUndefined()
        expect(openrouter.models["mistralai/mistral-medium-3.1"]).toBeDefined()
        await expect(Provider.getModel("openrouter", "mistralai/mistral-small-3.2-24b-instruct")).rejects.toThrow()
      },
    })
  })

  test("Meta BYOK overrides a path-prefixed stale managed proxy and bypasses the managed whitelist", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "byok" },
        provider: { meta: { whitelist: ["not-the-muse-model"] } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("META_MODEL_API_KEY", "meta-user-owned")
        Env.set("META_MODEL_BASE_URL", "https://atlas.example/control/api/llm/proxy/meta/v1")
        Provider.invalidate()
      },
      fn: async () => {
        const meta = (await Provider.list())["meta"]
        expect(meta).toBeDefined()
        expect(meta.options.apiKey).toBe("meta-user-owned")
        expect(meta.options.baseURL).toBe("https://api.meta.ai/v1")
        expect(meta.models["muse-spark-1.1"]).toBeDefined()
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

// ── billing.llm gates the own-key vs managed-proxy route (1a/1b/1c) ─────────

/** Auth.json lives outside the per-test tmp project (it's keyed by XDG dirs
 *  isolated for the whole test *run*, not per test) — set and restore it like
 *  provider.test.ts's Codex OAuth cases so a stored own key never leaks
 *  across tests. */
async function withOpenRouterOwnKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = await Auth.get("openrouter")
  await Auth.set("openrouter", { type: "api", key })
  try {
    return await fn()
  } finally {
    if (previous) await Auth.set("openrouter", previous)
    else await Auth.remove("openrouter")
  }
}

describe("billing.llm gates OpenRouter's own-key vs managed-proxy route (1a/1b/1c)", () => {
  test("managed: a stored own key is overridden — routes to the Atlas proxy with the thk_ token, and reports source \"managed\"; the own key is untouched in auth", async () => {
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Env.set("OPENROUTER_API_KEY", "thk_openrouter")
          Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
          Provider.invalidate()
        },
        fn: async () => {
          const openrouter = (await Provider.list())["openrouter"]
          expect(openrouter).toBeDefined()
          // 1a: managed spend wins over the stored own key — Atlas proxy, thk_ token.
          expect(openrouter.options.baseURL).toBe(`${PROXY}/openrouter/v1`)
          expect(openrouter.options.baseURL).not.toBe("https://openrouter.ai/api/v1")
          expect(openrouter.options.apiKey).toBe("thk_openrouter")
          expect(openrouter.options.apiKey).not.toBe("sk-or-own-key")
          // 1b: the managed route reports its true source.
          expect(openrouter.source).toBe("managed")
        },
      })
      // 1a: the own key is retained (never deleted/rewritten), just unused.
      expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "sk-or-own-key" })
    })
  })

  test("byok: a stored own key routes to public OpenRouter and reports source \"api\" (regression guard for 1c)", async () => {
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      // config.provider.openrouter must be genuinely present (here, via a
      // synced whitelist) for this to actually exercise 1c — otherwise the
      // "load config" loop never iterates openrouter at all and this test
      // would pass even without the 1c fix.
      await using tmp = await tmpdir({
        config: {
          billing: { llm: "byok" },
          provider: { openrouter: { whitelist: ["anthropic/claude-sonnet-5"] } },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Provider.invalidate()
        },
        fn: async () => {
          const openrouter = (await Provider.list())["openrouter"]
          expect(openrouter).toBeDefined()
          expect(openrouter.options.apiKey).toBe("sk-or-own-key")
          expect(openrouter.options.baseURL).toBe("https://openrouter.ai/api/v1")
          expect(openrouter.source).toBe("api")
        },
      })
    })
  })

  test("auto-detect (billing.llm unset): a stored own key still wins — unchanged from today's behaviour", async () => {
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      await using tmp = await tmpdir({ config: {} })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Provider.invalidate()
        },
        fn: async () => {
          const openrouter = (await Provider.list())["openrouter"]
          expect(openrouter).toBeDefined()
          expect(openrouter.options.apiKey).toBe("sk-or-own-key")
          expect(openrouter.options.baseURL).toBe("https://openrouter.ai/api/v1")
          expect(openrouter.source).toBe("api")
        },
      })
    })
  })

  test("auto-detect (billing.llm unset) with a synced thk_ token and no own key genuinely IS managed — source \"managed\" and Inference.classify \"managed\", not \"unknown\"", async () => {
    await using tmp = await tmpdir({ config: {} })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter).toBeDefined()
        expect(openrouter.options.apiKey).toBe("thk_openrouter")
        expect(openrouter.options.baseURL).toBe(`${PROXY}/openrouter/v1`)
        expect(openrouter.source).toBe("managed")

        // Feed the REAL provider.source this fixture produced straight into
        // classify — not Inference.resolve(), whose baseURL fallback would
        // resolve through this test harness's loopback OPENSCIENCE_API_BASE
        // (test/preload.ts) and get short-circuited by the unrelated
        // local()-heuristic before ever reaching the providerSource check.
        expect(Inference.classify({ providerID: "openrouter", providerSource: openrouter.source })).toBe("managed")
      },
    })
  })

  test("1c must not overshoot: a provider whose key genuinely comes from config.provider still reports source \"config\"", async () => {
    // No env var, no stored auth key, no billing toggle — OpenRouter's own
    // custom loader declines to register the provider (nothing to route
    // with), so the config loop below is the FIRST and only stage to claim
    // it. That's the "genuinely config" case the asymmetry note describes.
    await using tmp = await tmpdir({
      config: {
        provider: {
          openrouter: {
            options: { apiKey: "config-owned-key" },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter).toBeDefined()
        expect(openrouter.options.apiKey).toBe("config-owned-key")
        expect(openrouter.source).toBe("config")
      },
    })
  })

  test("1c must not overshoot the other way: an env-registered provider that also appears in config.provider (for its whitelist) keeps source \"env\"", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: { anthropic: { whitelist: ["claude-sonnet-4-6"] } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "sk-ant-env-key")
        Provider.invalidate()
      },
      fn: async () => {
        const anthropic = (await Provider.list())["anthropic"]
        expect(anthropic).toBeDefined()
        expect(anthropic.key).toBe("sk-ant-env-key")
        // The config entry only supplies a whitelist — the credential is genuinely env's.
        expect(anthropic.source).toBe("env")
      },
    })
  })

  test("1c (narrowed): an autoloaded custom-loader provider that also appears in config.provider (for its whitelist) still reports source \"config\", not \"custom\"", async () => {
    // google-vertex autoloads off GOOGLE_CLOUD_PROJECT alone (no auth.json
    // entry, and its models.dev `env` array — GOOGLE_VERTEX_PROJECT etc. —
    // never matches, so the "load env" stage never registers it either).
    // CUSTOM_LOADERS is the first and only stage to register it, with
    // source "custom" — exactly the loader-assigned (not credential-derived)
    // case 1c must keep overwriting to "config" when a config.provider entry
    // exists, per the narrowed protected set (env/api/managed only).
    await using tmp = await tmpdir({
      config: {
        provider: { "google-vertex": { whitelist: ["gemini-3.5-flash"] } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("GOOGLE_CLOUD_PROJECT", "test-project")
        Provider.invalidate()
      },
      fn: async () => {
        try {
          const vertex = (await Provider.list())["google-vertex"]
          expect(vertex).toBeDefined()
          expect(vertex.source).toBe("config")
        } finally {
          Env.remove("GOOGLE_CLOUD_PROJECT")
        }
      },
    })
  })
})
