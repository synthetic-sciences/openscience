import { test, expect, mock } from "bun:test"

// Match provider.test.ts: keep provider init hermetic (no real npm installs / plugins).
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

import path from "path"
import { generateText } from "ai"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"

// Minimal OpenAI-compatible chat-completion body so generateText resolves cleanly.
const completion = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

// Echo server: records the Authorization header of every request, answers with a
// valid completion so the request path runs to completion through the fetch hook.
function echoServer() {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(req.headers.get("authorization") ?? "")
      return Response.json(completion)
    },
  })
  return { seen, url: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) }
}

async function provider(dir: string, options: Record<string, unknown>) {
  await Bun.write(
    path.join(dir, "openscience.json"),
    JSON.stringify({
      $schema: "https://syntheticsciences.ai/config.json",
      provider: {
        "token-cmd": {
          name: "Token Command Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { m: { name: "M", tool_call: false, limit: { context: 4000, output: 1000 } } },
          options,
        },
      },
    }),
  )
}

test("tokenCommand mints a bearer token and sends it on the wire (#146)", async () => {
  const srv = echoServer()
  try {
    await using tmp = await tmpdir({
      init: (dir) => provider(dir, { baseURL: srv.url, tokenCommand: "echo minted-secret-42" }),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel("token-cmd", "m")
        const language = await Provider.getLanguage(model)
        await generateText({ model: language, prompt: "hi" }).catch(() => {})
      },
    })
  } finally {
    srv.stop()
  }
  expect(srv.seen.length).toBeGreaterThan(0)
  // The command's stdout (trimmed) is the bearer token the server received.
  expect(srv.seen[0]).toBe("Bearer minted-secret-42")
})

test("tokenCommand overrides a static apiKey (command wins)", async () => {
  const srv = echoServer()
  try {
    await using tmp = await tmpdir({
      init: (dir) =>
        provider(dir, { baseURL: srv.url, apiKey: "static-key-should-lose", tokenCommand: "echo fresh-token" }),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel("token-cmd", "m")
        const language = await Provider.getLanguage(model)
        await generateText({ model: language, prompt: "hi" }).catch(() => {})
      },
    })
  } finally {
    srv.stop()
  }
  expect(srv.seen[0]).toBe("Bearer fresh-token")
  expect(srv.seen[0]).not.toContain("static-key-should-lose")
})
