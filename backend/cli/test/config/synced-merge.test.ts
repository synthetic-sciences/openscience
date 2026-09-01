import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

// Atlas versions before local-first OpenScience wrote openscience-synced.json into
// the user's XDG config dir. Current OpenScience must ignore that retired dashboard
// policy file so it cannot restore a server-selected model or narrow local BYOK
// providers after an upgrade. These tests exercise the real Config load path.
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

describe("retired Atlas synced-config isolation", () => {
  test("user's default model and custom OpenRouter model survive a retired policy file (#159)", async () => {
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
        expect(config.model).toBe("openrouter/deepseek/deepseek-v4-pro")
        expect(config.provider?.openrouter?.models?.["deepseek/deepseek-v4-pro"]).toBeDefined()
        expect(config.provider?.openrouter?.models?.["anthropic/claude-opus-4.8"]).toBeUndefined()
      },
    })
  })

  test("retired policy cannot select a model when the user has not set one", async () => {
    await writeSynced({
      model: "openrouter/anthropic/claude-opus-4.8",
      provider: { openrouter: { models: { "anthropic/claude-opus-4.8": {} } } },
    })

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.model).toBeUndefined()
        expect(config.provider?.openrouter?.models?.["anthropic/claude-opus-4.8"]).toBeUndefined()
      },
    })
  })

  test("stale synced Meta model config is ignored because managed Muse routes through OpenRouter", async () => {
    await writeSynced({
      model: "meta/muse-spark-1.1",
      provider: { meta: { whitelist: ["muse-spark-1.1"] } },
    })

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.model).toBeUndefined()
        expect(config.provider?.meta).toBeUndefined()
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
        expect(config.provider?.["my-byok"]).toBeDefined()
        expect(config.provider?.["my-byok"]?.options?.baseURL).toBe("https://byok.example/v1")
      },
    })
  })
})
