import { test, expect, describe, mock } from "bun:test"

// Mock BunProc + default auth plugins so importing Provider never shells out or
// hits the network (mirrors test/provider/provider.test.ts).
mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string) => {
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

describe("Provider.isLocalBaseURL (pure)", () => {
  test("recognizes loopback hosts", () => {
    for (const u of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://0.0.0.0:8000/v1",
      "http://[::1]:8080/v1",
    ]) {
      expect(Provider.isLocalBaseURL(u)).toBe(true)
    }
  })
  test("rejects remote hosts and junk", () => {
    for (const u of ["https://api.openai.com/v1", "http://myserver.local/v1", "", undefined, "not a url"]) {
      expect(Provider.isLocalBaseURL(u as any)).toBe(false)
    }
  })
})

const ollamaBlock = {
  name: "Ollama (local)",
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: "http://localhost:11434/v1", apiKey: "local" },
  models: { "llama3.1": { name: "llama3.1", limit: { context: 8192, output: 2048 } } },
}

describe("local provider availability", () => {
  test("a local provider loads in BYOK/auto mode", async () => {
    await using tmp = await tmpdir({ config: { provider: { ollama: ollamaBlock } } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => Provider.invalidate(),
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["ollama"]).toBeDefined()
        expect(providers["ollama"].options.baseURL).toBe("http://localhost:11434/v1")
        expect(Object.keys(providers["ollama"].models)).toContain("llama3.1")
      },
    })
  })

  test("a local provider stays available even in managed-wallet mode (it's free)", async () => {
    await using tmp = await tmpdir({ config: { billing: { llm: "managed" }, provider: { ollama: ollamaBlock } } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => Provider.invalidate(),
      fn: async () => {
        const providers = await Provider.list()
        // managed drops anthropic/openai/google, but NOT the local endpoint.
        expect(providers["ollama"]).toBeDefined()
        expect(providers["anthropic"]).toBeUndefined()
      },
    })
  })
})
