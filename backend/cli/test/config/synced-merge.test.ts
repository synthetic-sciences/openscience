import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

// The Atlas sync writes openscience-synced.json into the user's XDG config dir; it's
// read fresh per-instance by Config.state(). The user's own config goes in the
// project's openscience.json (via tmpdir({config})), which is per-test isolated —
// unlike the global openscience.json, which Config caches process-wide. These tests
// exercise the real Config load path end-to-end (#159 / #142).
const syncedConfig = path.join(Global.Path.config, "openscience-synced.json")

async function writeSynced(obj: object) {
  await fs.mkdir(path.dirname(syncedConfig), { recursive: true })
  await Bun.write(syncedConfig, JSON.stringify({ $schema: "https://syntheticsciences.ai/config.json", ...obj }))
}

beforeEach(async () => {
  await fs.rm(syncedConfig, { force: true }).catch(() => {})
})
afterEach(async () => {
  await fs.rm(syncedConfig, { force: true }).catch(() => {})
})

describe("Atlas synced-config merge", () => {
  test("user's default model and custom OpenRouter model survive the sync (#159)", async () => {
    await writeSynced({
      model: "openrouter/anthropic/claude-opus-4.8",
      provider: { openrouter: { models: { "anthropic/claude-opus-4.8": {} } } },
    })

    await using tmp = await tmpdir({
      config: {
        model: "openrouter/deepseek/deepseek-v4-pro",
        provider: { openrouter: { models: { "deepseek/deepseek-v4-pro": {} } } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        // 1. The user's chosen default model wins — NOT reverted to the synced one.
        expect(config.model).toBe("openrouter/deepseek/deepseek-v4-pro")
        // 2. The user's custom model persists (this is what was being clobbered).
        expect(config.provider?.openrouter?.models?.["deepseek/deepseek-v4-pro"]).toBeDefined()
        // 3. The server-recommended model the user did NOT declare is still added (union).
        expect(config.provider?.openrouter?.models?.["anthropic/claude-opus-4.8"]).toBeDefined()
      },
    })
  })

  test("synced config still applies when the user hasn't set those fields", async () => {
    await writeSynced({
      model: "openrouter/anthropic/claude-opus-4.8",
      provider: { openrouter: { models: { "anthropic/claude-opus-4.8": {} } } },
    })

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        // With no competing user value, the server recommendation is the default.
        expect(config.model).toBe("openrouter/anthropic/claude-opus-4.8")
        expect(config.provider?.openrouter?.models?.["anthropic/claude-opus-4.8"]).toBeDefined()
      },
    })
  })

  test("a custom BYOK provider in openscience.json is untouched by sync (#142)", async () => {
    await writeSynced({
      enabled_providers: ["openrouter"],
      provider: { openrouter: { models: { "anthropic/claude-opus-4.8": {} } } },
    })

    await using tmp = await tmpdir({
      config: {
        provider: { "my-byok": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://byok.example/v1" } } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        // The synced enabled_providers=[openrouter] must NOT drop the custom provider.
        expect(config.provider?.["my-byok"]).toBeDefined()
        expect(config.provider?.["my-byok"]?.options?.baseURL).toBe("https://byok.example/v1")
      },
    })
  })
})
