import { test, expect, mock } from "bun:test"
import path from "path"

// Mock BunProc and default plugins to prevent actual installations during tests
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

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Env } from "../../src/env"
import { Auth } from "../../src/auth"

/* Pinned against the live models.dev catalog. When models.dev delists one of
   these ids, the "pinned catalog models still exist upstream" test below fails
   with instructions — update the pin here and every test follows. Previous
   pin claude-sonnet-4-20250514 was delisted upstream on 2026-07-05 and broke
   10 tests at once. */
const SONNET = "claude-sonnet-4-6"
const OPUS = "claude-opus-4-5"

test("Codex OAuth allowlist includes the GPT-5.6 family", () => {
  for (const id of [
    "gpt-5.6",
    "gpt-5-6",
    "gpt-5.6-sol",
    "gpt-5-6-sol",
    "gpt-5.6-terra",
    "gpt-5-6-terra",
    "gpt-5.6-luna",
    "gpt-5-6-luna",
  ]) {
    expect(Provider.isCodexModel(id)).toBe(true)
  }
})

test("Codex OAuth synthesizes the GPT-5.6 family from the catalog", async () => {
  await using tmp = await tmpdir({})
  await Auth.set("openai-codex", {
    type: "oauth",
    refresh: "test-refresh",
    access: "test-access",
    expires: Date.now() + 60_000,
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = (await Provider.list())["openai-codex"]
      expect(provider).toBeDefined()
      for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
        expect(provider.models[id]?.providerID).toBe("openai-codex")
        expect(provider.models[id]?.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
      }
    },
  })
  await Auth.remove("openai-codex")
})

test("pinned catalog models are present in the seeded test fixture", async () => {
  await using tmp = await tmpdir({})
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const models = Object.keys(providers["anthropic"]?.models ?? {})
      for (const id of [SONNET, OPUS]) {
        if (!models.includes(id))
          throw new Error(
            `test fixture is missing anthropic/${id} — regenerate test/fixture/models-catalog.json.gz or update the SONNET/OPUS pins here (a live models.dev delisting is caught separately by the scheduled catalog job)`,
          )
      }
    },
  })
})

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

test("provider loaded from env variable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      // Provider should retain its connection source even if custom loaders
      // merge additional options.
      expect(providers["anthropic"].source).toBe("env")
      expect(providers["anthropic"].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              options: {
                apiKey: "config-api-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
    },
  })
})

test("disabled_providers excludes provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          disabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeUndefined()
    },
  })
})

test("enabled_providers restricts to only listed providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          enabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["openai"]).toBeUndefined()
    },
  })
})

test("openrouter with a BYOK env key routes to public OpenRouter with that key", async () => {
  await using tmp = await tmpdir({})
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "sk-or-user-byok")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"]).toBeDefined()
      expect(providers["openrouter"].options["apiKey"]).toBe("sk-or-user-byok")
      expect(providers["openrouter"].options["baseURL"]).toBe("https://openrouter.ai/api/v1")
    },
  })
})

test("a BYOK openrouter key overrides a lingering synced proxy base URL (no misroute)", async () => {
  await using tmp = await tmpdir({})
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "sk-or-user-byok")
      // A proxy base URL left in env from a prior managed session must NOT
      // capture the user's own key — the resolver pins it to public OpenRouter.
      Env.set("OPENROUTER_BASE_URL", "https://thesis-synsc.fly.dev/api/llm/proxy/openrouter/v1")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"].options["apiKey"]).toBe("sk-or-user-byok")
      expect(providers["openrouter"].options["baseURL"]).toBe("https://openrouter.ai/api/v1")
    },
  })
})

test("openrouter BYOK honours a custom (non-Atlas) OPENROUTER_BASE_URL gateway", async () => {
  await using tmp = await tmpdir({})
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "sk-or-user-byok")
      // A user's own OpenRouter-compatible gateway — must be preserved, not
      // forced to public openrouter.ai (only the Atlas proxy is swapped out).
      Env.set("OPENROUTER_BASE_URL", "https://my-gateway.example/api/v1")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"].options["apiKey"]).toBe("sk-or-user-byok")
      expect(providers["openrouter"].options["baseURL"]).toBe("https://my-gateway.example/api/v1")
    },
  })
})

test("openrouter on a BYOK key ignores the managed whitelist and shows the full catalog", async () => {
  await using tmp = await tmpdir({
    config: {
      // The curated managed whitelist binds only the managed route.
      provider: { openrouter: { whitelist: ["deepseek/deepseek-r1"] } },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "sk-or-user-byok")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"]).toBeDefined()
      // BYOK ⇒ whitelist skipped ⇒ far more than the single whitelisted model.
      expect(Object.keys(providers["openrouter"].models).length).toBeGreaterThan(1)
    },
  })
})

test("google forwards a GOOGLE_API_KEY alias to the SDK apiKey (SDK only reads GOOGLE_GENERATIVE_AI_API_KEY)", async () => {
  await using tmp = await tmpdir({})
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // Detected from the alias, but @ai-sdk/google won't auto-load it — the
      // loader must forward it or calls fail with "API key is missing".
      Env.set("GOOGLE_API_KEY", "AIza-google-alias")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["google"]).toBeDefined()
      expect(providers["google"].options["apiKey"]).toBe("AIza-google-alias")
    },
  })
})

test("model whitelist filters models for provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              whitelist: [SONNET],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).toContain(SONNET)
      expect(models.length).toBe(1)
    },
  })
})

test("model blacklist excludes specific models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              blacklist: [SONNET],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).not.toContain(SONNET)
    },
  })
})

test("custom model alias via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "my-alias": {
                  id: SONNET,
                  name: "My Custom Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["anthropic"].models["my-alias"]).toBeDefined()
      expect(providers["anthropic"].models["my-alias"].name).toBe("My Custom Alias")
    },
  })
})

test("custom provider with npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              env: ["CUSTOM_API_KEY"],
              models: {
                "custom-model": {
                  name: "Custom Model",
                  tool_call: true,
                  limit: {
                    context: 128000,
                    output: 4096,
                  },
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-provider"]).toBeDefined()
      expect(providers["custom-provider"].name).toBe("Custom Provider")
      expect(providers["custom-provider"].models["custom-model"]).toBeDefined()
    },
  })
})

test("env variable takes precedence, config merges options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              options: {
                timeout: 60000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "env-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      // Config options should be merged
      expect(providers["anthropic"].options.timeout).toBe(60000)
    },
  })
})

test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getModel("anthropic", SONNET)
      expect(model).toBeDefined()
      expect(model.providerID).toBe("anthropic")
      expect(model.id).toBe(SONNET)
      const language = await Provider.getLanguage(model)
      expect(language).toBeDefined()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      expect(Provider.getModel("anthropic", "nonexistent-model")).rejects.toThrow()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(Provider.getModel("nonexistent-provider", "some-model")).rejects.toThrow()
    },
  })
})

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(result.providerID).toBe("anthropic")
  expect(result.modelID).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(result.providerID).toBe("openrouter")
  expect(result.modelID).toBe("anthropic/claude-3-opus")
})

test("defaultModel returns first available model when no config set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          model: `anthropic/${SONNET}`,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(model.providerID).toBe("anthropic")
      expect(model.modelID).toBe(SONNET)
    },
  })
})

test("provider with baseURL from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.openai.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-openai"]).toBeDefined()
      expect(providers["custom-openai"].options.baseURL).toBe("https://custom.openai.com/v1")
    },
  })
})

test("model cost defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.cost.input).toBe(0)
      expect(model.cost.output).toBe(0)
      expect(model.cost.cache.read).toBe(0)
      expect(model.cost.cache.write).toBe(0)
    },
  })
})

test("model options are merged from existing model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  options: {
                    customOption: "custom-value",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.options.customOption).toBe("custom-value")
    },
  })
})

test("provider removed when all models filtered out", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              whitelist: ["nonexistent-model"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeUndefined()
    },
  })
})

test("closest finds model by partial match", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await Provider.closest("anthropic", ["sonnet-4"])
      expect(result).toBeDefined()
      expect(result?.providerID).toBe("anthropic")
      expect(result?.modelID).toContain("sonnet-4")
    },
  })
})

test("closest returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Provider.closest("nonexistent", ["model"])
      expect(result).toBeUndefined()
    },
  })
})

test("getModel uses realIdByKey for aliased models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "my-sonnet": {
                  id: SONNET,
                  name: "My Sonnet Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"].models["my-sonnet"]).toBeDefined()

      const model = await Provider.getModel("anthropic", "my-sonnet")
      expect(model).toBeDefined()
      expect(model.id).toBe("my-sonnet")
      expect(model.name).toBe("My Sonnet Alias")
    },
  })
})

test("provider api field sets model api.url", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      // api field is stored on model.api.url, used by getSDK to set baseURL
      expect(providers["custom-api"].models["model-1"].api.url).toBe("https://api.example.com/v1")
    },
  })
})

test("explicit baseURL overrides api field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.override.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-api"].options.baseURL).toBe("https://custom.override.com/v1")
    },
  })
})

test("model inherits properties from existing database model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  name: "Custom Name for Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.name).toBe("Custom Name for Sonnet")
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBeGreaterThan(0)
    },
  })
})

test("disabled_providers prevents loading even with env var", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openai"]).toBeUndefined()
    },
  })
})

test("enabled_providers with empty array allows no providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          enabled_providers: [],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(Object.keys(providers).length).toBe(0)
    },
  })
})

test("whitelist and blacklist can be combined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              whitelist: [SONNET, OPUS],
              blacklist: [OPUS],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).toContain(SONNET)
      expect(models).not.toContain(OPUS)
      expect(models.length).toBe(1)
    },
  })
})

test("model modalities default correctly", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.capabilities.input.text).toBe(true)
      expect(model.capabilities.output.text).toBe(true)
    },
  })
})

test("model with custom cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                  cost: {
                    input: 5,
                    output: 15,
                    cache_read: 2.5,
                    cache_write: 7.5,
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.cost.input).toBe(5)
      expect(model.cost.output).toBe(15)
      expect(model.cost.cache.read).toBe(2.5)
      expect(model.cost.cache.write).toBe(7.5)
    },
  })
})

test("getSmallModel returns appropriate small model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getSmallModel("anthropic")
      expect(model).toBeDefined()
      expect(model?.id).toContain("haiku")
    },
  })
})

test("getSmallModel respects config small_model override", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          small_model: `anthropic/${SONNET}`,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getSmallModel("anthropic")
      expect(model).toBeDefined()
      expect(model?.providerID).toBe("anthropic")
      expect(model?.id).toBe(SONNET)
    },
  })
})

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

test("multiple providers can be configured simultaneously", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              options: { timeout: 30000 },
            },
            openai: {
              options: { timeout: 60000 },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-anthropic-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["openai"]).toBeDefined()
      expect(providers["anthropic"].options.timeout).toBe(30000)
      expect(providers["openai"].options.timeout).toBe(60000)
    },
  })
})

test("managed atlas proxy base URLs are forwarded for managed LLM providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      clearManagedLLMEnv()
      Env.set("ANTHROPIC_API_KEY", "thk_anthropic")
      Env.set("ANTHROPIC_BASE_URL", "https://atlas.test/api/llm/proxy/anthropic/v1")
      Env.set("OPENAI_API_KEY", "thk_openai")
      Env.set("OPENAI_BASE_URL", "https://atlas.test/api/llm/proxy/openai/v1")
      Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "thk_google")
      Env.set("GOOGLE_GENERATIVE_AI_BASE_URL", "https://atlas.test/api/llm/proxy/gemini/v1beta")
      Env.set("OPENROUTER_API_KEY", "thk_openrouter")
      Env.set("OPENROUTER_BASE_URL", "https://atlas.test/api/llm/proxy/openrouter/v1")
      Provider.invalidate()
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"].options.baseURL).toBe("https://atlas.test/api/llm/proxy/anthropic/v1")
      expect(providers["openai"].options.baseURL).toBe("https://atlas.test/api/llm/proxy/openai/v1")
      expect(providers["google"].options.baseURL).toBe("https://atlas.test/api/llm/proxy/gemini/v1beta")
      expect(providers["openrouter"].options.baseURL).toBe("https://atlas.test/api/llm/proxy/openrouter/v1")
    },
  })
})

test("managed atlas keys without proxy base URLs fail before provider SDK creation", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      clearManagedLLMEnv()
      Env.set("OPENAI_API_KEY", "thk_missing_proxy")
      Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "thk_missing_google_proxy")
      Provider.invalidate()
    },
    fn: async () => {
      const providers = await Provider.list()
      for (const providerID of ["openai", "google"]) {
        const model = Object.values(providers[providerID].models)[0]
        expect(model).toBeDefined()
        let error: unknown
        try {
          await Provider.getLanguage(model!)
        } catch (e) {
          error = e
        }
        expect(error).toBeDefined()
        expect((error as Error).cause).toBeInstanceOf(Error)
        expect(((error as Error).cause as Error).message).toContain("managed Atlas key without an Atlas proxy URL")
      }
    },
  })
})

test("provider with custom npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "local-llm": {
              name: "Local LLM",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "llama-3": {
                  name: "Llama 3",
                  tool_call: true,
                  limit: { context: 8192, output: 2048 },
                },
              },
              options: {
                apiKey: "not-needed",
                baseURL: "http://localhost:11434/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["local-llm"]).toBeDefined()
      expect(providers["local-llm"].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(providers["local-llm"].options.baseURL).toBe("http://localhost:11434/v1")
    },
  })
})

// Edge cases for model configuration

test("model alias name defaults to alias key when id differs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                sonnet: {
                  id: SONNET,
                  // no name specified - should default to "sonnet" (the key)
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"].models["sonnet"].name).toBe("sonnet")
    },
  })
})

test("provider with multiple env var options only includes apiKey when single env", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "multi-env": {
              name: "Multi Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("MULTI_ENV_KEY_1", "test-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["multi-env"]).toBeDefined()
      // When multiple env options exist, key should NOT be auto-set
      expect(providers["multi-env"].key).toBeUndefined()
    },
  })
})

test("provider with single env var includes apiKey automatically", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "single-env": {
              name: "Single Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["SINGLE_ENV_KEY"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("SINGLE_ENV_KEY", "my-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["single-env"]).toBeDefined()
      // Single env option should auto-set key
      expect(providers["single-env"].key).toBe("my-api-key")
    },
  })
})

test("model cost overrides existing cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  cost: {
                    input: 999,
                    output: 888,
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.cost.input).toBe(999)
      expect(model.cost.output).toBe(888)
    },
  })
})

test("completely new provider not in database can be configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "brand-new-provider": {
              name: "Brand New",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              api: "https://new-api.com/v1",
              models: {
                "new-model": {
                  name: "New Model",
                  tool_call: true,
                  reasoning: true,
                  attachment: true,
                  temperature: true,
                  limit: { context: 32000, output: 8000 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "new-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["brand-new-provider"]).toBeDefined()
      expect(providers["brand-new-provider"].name).toBe("Brand New")
      const model = providers["brand-new-provider"].models["new-model"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
    },
  })
})

test("disabled_providers and enabled_providers interaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          // enabled_providers takes precedence - only these are considered
          enabled_providers: ["anthropic", "openai"],
          // Then disabled_providers filters from the enabled set
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-anthropic")
      Env.set("OPENAI_API_KEY", "test-openai")
      Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "test-google")
    },
    fn: async () => {
      const providers = await Provider.list()
      // anthropic: in enabled, not in disabled = allowed
      expect(providers["anthropic"]).toBeDefined()
      // openai: in enabled, but also in disabled = NOT allowed
      expect(providers["openai"]).toBeUndefined()
      // google: not in enabled = NOT allowed (even though not disabled)
      expect(providers["google"]).toBeUndefined()
    },
  })
})

test("model with tool_call false", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "no-tools": {
              name: "No Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "basic-model": {
                  name: "Basic Model",
                  tool_call: false,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["no-tools"].models["basic-model"].capabilities.toolcall).toBe(false)
    },
  })
})

test("model defaults tool_call to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "default-tools": {
              name: "Default Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  // tool_call not specified
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["default-tools"].models["model"].capabilities.toolcall).toBe(true)
    },
  })
})

test("model headers are preserved", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "headers-provider": {
              name: "Headers Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "X-Custom-Header": "custom-value",
                    Authorization: "Bearer special-token",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["headers-provider"].models["model"]
      expect(model.headers).toEqual({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer special-token",
      })
    },
  })
})

test("provider env fallback - second env var used if first missing", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "fallback-env": {
              name: "Fallback Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["PRIMARY_KEY", "FALLBACK_KEY"],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { baseURL: "https://api.example.com" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // Only set fallback, not primary
      Env.set("FALLBACK_KEY", "fallback-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Provider should load because fallback env var is set
      expect(providers["fallback-env"]).toBeDefined()
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model1 = await Provider.getModel("anthropic", SONNET)
      const model2 = await Provider.getModel("anthropic", SONNET)
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

test("provider name defaults to id when not in database", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "my-custom-id": {
              // no name specified
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["my-custom-id"].name).toBe("my-custom-id")
    },
  })
})

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel("anthropic", "claude-sonet-4") // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel("antropic", "claude-sonnet-4") // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = await Provider.getProvider("nonexistent")
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const provider = await Provider.getProvider("anthropic")
      expect(provider).toBeDefined()
      expect(provider?.id).toBe("anthropic")
    },
  })
})

test("closest returns undefined when no partial match found", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await Provider.closest("anthropic", ["nonexistent-xyz-model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest checks multiple query terms in order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      // First term won't match, second will
      const result = await Provider.closest("anthropic", ["nonexistent", "haiku"])
      expect(result).toBeDefined()
      expect(result?.modelID).toContain("haiku")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["no-limit"].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Custom options should be merged
      expect(providers["anthropic"].options.timeout).toBe(30000)
      expect(providers["anthropic"].options.headers["X-Custom"]).toBe("custom-value")
      // anthropic custom loader adds its own headers, they should coexist
      expect(providers["anthropic"].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("custom model inherits npm package from models.dev provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            openai: {
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["openai"].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai")
    },
  })
})

test("custom model inherits api.url from models.dev provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            openrouter: {
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers["openrouter"].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

      // Another new model should also inherit api.url
      const deepseek = providers["openrouter"].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

test("model variants are generated for reasoning models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Claude sonnet 4 has reasoning capability
      const model = providers["anthropic"].models[SONNET]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
    },
  })
})

test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // max variant should still exist
      expect(model.variants!["max"]).toBeDefined()
    },
  })
})

test("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  variants: {
                    low: { disabled: true },
                    medium: { disabled: true },
                    high: { disabled: true },
                    max: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBe(0)
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            anthropic: {
              models: {
                [SONNET]: {
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models[SONNET]
      expect(model.variants!["high"]).toBeDefined()
      // Should have both the generated thinking config and the custom option
      expect(model.variants!["high"].thinking).toBeDefined()
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("variants filtered in second pass for database models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            openai: {
              models: {
                "gpt-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["openai"].models["gpt-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // Other variants should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          $schema: "https://syntheticsciences.ai/config.json",
          provider: {
            "custom-reasoning": {
              name: "Custom Reasoning Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "reasoning-model": {
                  name: "Reasoning Model",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 128000, output: 16000 },
                  variants: {
                    low: { reasoningEffort: "low" },
                    medium: { reasoningEffort: "medium" },
                    high: { reasoningEffort: "high", disabled: true },
                    custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                  },
                },
              },
              options: { apiKey: "test-key" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["custom-reasoning"].models["reasoning-model"]
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})
