import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config/config"

describe("Config.setProvider / removeProvider", () => {
  test("registers a local provider block that a fresh load reflects", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.setProvider(
          "ollama",
          {
            name: "Ollama (local)",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://localhost:11434/v1", apiKey: "local" },
            models: { "llama3.1": { name: "llama3.1", limit: { context: 32768, output: 8192 } } },
          } as any,
          "project",
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await Config.get()
        expect(cfg.provider?.ollama?.options?.baseURL).toBe("http://localhost:11434/v1")
        expect(Object.keys(cfg.provider?.ollama?.models ?? {})).toEqual(["llama3.1"])
      },
    })
  })

  test("removeProvider deletes the block", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.setProvider("ollama", { name: "x", options: { baseURL: "http://h/v1" } } as any, "project")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.removeProvider("ollama", "project")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Config.get()).provider?.ollama).toBeUndefined()
      },
    })
  })
})
