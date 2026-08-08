import { test, expect, mock, beforeEach } from "bun:test"

// Match provider.test.ts: keep provider init hermetic (no real npm installs / plugins).
const installs: string[] = []
const packageURL = new URL("../fixture/provider-module.mjs", import.meta.url).href
await import(packageURL)
mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string) => {
      installs.push(pkg)
      if (pkg === "project-provider-probe") return packageURL
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
import fs from "fs/promises"
import { generateText } from "ai"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"

beforeEach(() => {
  installs.length = 0
})

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

async function packageProvider(dir: string) {
  const marker = path.join(dir, "provider-package-ran")
  await Bun.write(
    path.join(dir, "openscience.json"),
    JSON.stringify({
      provider: {
        probe: {
          name: "Project package probe",
          npm: "project-provider-probe",
          env: [],
          models: {
            m: {
              name: "Probe",
              limit: {
                context: 1000,
                output: 100,
              },
            },
          },
        },
      },
    }),
  )
  return marker
}

async function trust() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, {
    trusted: true,
    root: status.root,
  })
}

test("untrusted project tokenCommand cannot spawn", async () => {
  const srv = echoServer()
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const marker = path.join(dir, "token-command-ran")
        await provider(dir, {
          baseURL: srv.url,
          tokenCommand: `printf ran > ${JSON.stringify(marker)}; printf blocked-token`,
        })
        return marker
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const model = await Provider.getModel("token-cmd", "m")
        const language = await Provider.getLanguage(model)
        await generateText({ model: language, prompt: "hi" }).catch(() => {})
        expect(await Bun.file(tmp.extra).exists()).toBe(false)
      },
    })
  } finally {
    srv.stop()
  }
  expect(srv.seen).toEqual([])
})

test("untrusted project npm provider cannot install or import", async () => {
  await using tmp = await tmpdir({ init: packageProvider })
  process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER = tmp.extra
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const model = await Provider.getModel("probe", "m")
        expect(model.api.npm).toBe("project-provider-probe")
        await expect(Provider.getLanguage(model)).rejects.toBeInstanceOf(Provider.InitError)
        expect(await Bun.file(tmp.extra).exists()).toBe(false)
      },
    })
  } finally {
    delete process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER
  }
  expect(installs).not.toContain("project-provider-probe")
})

test("untrusted project preserves a user-configured npm provider", async () => {
  const previous = process.env.OPENSCIENCE_CONFIG_DIR
  await using config = await tmpdir({ init: packageProvider })
  await using project = await tmpdir()
  process.env.OPENSCIENCE_CONFIG_DIR = config.path
  process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER = config.extra
  try {
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const model = await Provider.getModel("probe", "m")
        await expect(Provider.getLanguage(model)).resolves.toBeDefined()
        expect(await Bun.file(config.extra).text()).toBe("created")
      },
    })
  } finally {
    delete process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER
    if (previous === undefined) delete process.env.OPENSCIENCE_CONFIG_DIR
    if (previous !== undefined) process.env.OPENSCIENCE_CONFIG_DIR = previous
  }
  expect(installs).toContain("project-provider-probe")
})

test("trusted project npm provider can install and import", async () => {
  await using tmp = await tmpdir({ init: packageProvider })
  process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER = tmp.extra
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trust()
        const model = await Provider.getModel("probe", "m")
        await expect(Provider.getLanguage(model)).resolves.toBeDefined()
        expect(await Bun.file(tmp.extra).text()).toBe("created")
      },
    })
  } finally {
    delete process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER
  }
  expect(installs).toContain("project-provider-probe")
})

test("revocation invalidates a loaded project provider cache", async () => {
  await using tmp = await tmpdir({ init: packageProvider })
  process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER = tmp.extra
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trust()
        const model = await Provider.getModel("probe", "m")
        await expect(Provider.getLanguage(model)).resolves.toBeDefined()
        expect(await Bun.file(tmp.extra).text()).toBe("created")
        await fs.rm(tmp.extra)

        await ProjectTrust.update(Instance.project, { trusted: false })

        await expect(Provider.getLanguage(model)).rejects.toBeInstanceOf(Provider.InitError)
        expect(await Bun.file(tmp.extra).exists()).toBe(false)
      },
    })
  } finally {
    delete process.env.OPENSCIENCE_TEST_PROVIDER_MODULE_MARKER
  }
  expect(installs.filter((item) => item === "project-provider-probe")).toHaveLength(1)
})

test("tokenCommand mints a bearer token and sends it on the wire (#146)", async () => {
  const srv = echoServer()
  try {
    await using tmp = await tmpdir({
      init: (dir) => provider(dir, { baseURL: srv.url, tokenCommand: "echo minted-secret-42" }),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trust()
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
        await trust()
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
