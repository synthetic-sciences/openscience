import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LocalModelsRoutes, LocalRuntime } from "../../src/server/routes/settings/local"

const app = LocalModelsRoutes()

// A real in-process OpenAI-compatible mock server so these tests never touch the
// global fetch (which would race with other test files) or the network.
let server: ReturnType<typeof Bun.serve>
let mockBase = ""
const created: unknown[] = []
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "llama3.1" }, { id: "qwen2.5" }] })
      if (url.pathname === "/api/create") {
        created.push(await req.json())
        return Response.json({ status: "success" })
      }
      return new Response("not found", { status: 404 })
    },
  })
  mockBase = `http://127.0.0.1:${server.port}/v1`
})
afterAll(() => server?.stop(true))

describe("/settings/local routes", () => {
  test("local runtimes receive configuration without host credentials or control-plane state", () => {
    const env = LocalRuntime.environment({
      PATH: "/usr/bin:/bin",
      HOME: "/home/researcher",
      OLLAMA_MODELS: "/models",
      OPENAI_API_KEY: "provider-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      MODAL_TOKEN_SECRET: "modal-secret",
      ATLAS_API_KEY: "atlas-secret",
      OPENSCIENCE_CONFIG_CONTENT: "control-plane-state",
      DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
      PYTHONSTARTUP: "/tmp/startup.py",
    })

    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.HOME).toBe("/home/researcher")
    expect(env.OLLAMA_MODELS).toBe("/models")
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.MODAL_TOKEN_SECRET).toBeUndefined()
    expect(env.ATLAS_API_KEY).toBeUndefined()
    expect(env.OPENSCIENCE_CONFIG_CONTENT).toBeUndefined()
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(env.PYTHONSTARTUP).toBeUndefined()
  })

  test("owns and reaps a real local-runtime child instead of unrefing it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-local-runtime-"))
    const environment = path.join(root, "environment.json")
    const pidfile = path.join(root, "runtime.pid")
    const id = `fixture-${crypto.randomUUID()}`
    const fixture = path.resolve(import.meta.dir, "../fixture/local-runtime-process.ts")
    const saved = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      MODAL_TOKEN_SECRET: process.env.MODAL_TOKEN_SECRET,
      OPENSCIENCE_CONFIG_CONTENT: process.env.OPENSCIENCE_CONFIG_CONTENT,
    }
    process.env.OPENAI_API_KEY = "provider-host-secret"
    process.env.AWS_SECRET_ACCESS_KEY = "cloud-host-secret"
    process.env.MODAL_TOKEN_SECRET = "modal-host-secret"
    process.env.OPENSCIENCE_CONFIG_CONTENT = "host-control-plane"
    let pid = 0
    try {
      const started = await LocalRuntime.start({
        id,
        file: process.execPath,
        args: [fixture, environment, pidfile],
        timeoutMs: 5_000,
        probe: async () => {
          const value = await fs.readFile(pidfile, "utf8").catch(() => undefined)
          return value ? ["fixture-model"] : null
        },
      })
      expect(started).toEqual({ alreadyRunning: false, value: ["fixture-model"] })
      pid = Number(await fs.readFile(pidfile, "utf8"))
      expect(pid).toBeGreaterThan(0)
      const childEnv = JSON.parse(await fs.readFile(environment, "utf8")) as Record<string, string>
      expect(childEnv.OPENAI_API_KEY).toBeUndefined()
      expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(childEnv.MODAL_TOKEN_SECRET).toBeUndefined()
      expect(childEnv.OPENSCIENCE_CONFIG_CONTENT).toBeUndefined()

      expect(await LocalRuntime.stop(id)).toBe(true)
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          process.kill(pid, 0)
        } catch {
          pid = 0
          break
        }
        await Bun.sleep(10)
      }
      expect(pid).toBe(0)
    } finally {
      await LocalRuntime.stop(id).catch(() => undefined)
      if (pid) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test("POST /models lists a running endpoint's models", async () => {
    const res = await app.request("/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: mockBase }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { baseURL: string; models: string[] }
    expect(body.baseURL).toBe(mockBase)
    expect(body.models).toEqual(["llama3.1", "qwen2.5"])
  })

  test("POST /models reports an error (200) when the endpoint is unreachable", async () => {
    // 127.0.0.1:1 — nothing listens there; connection is refused fast.
    const res = await app.request("/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1/v1" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { models: string[]; error?: string }
    expect(body.models).toEqual([])
    expect(body.error).toBeTruthy()
  })

  test("POST /context creates a tuned Ollama alias with the requested num_ctx", async () => {
    const res = await app.request("/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: mockBase, model: "llama3.1", context: 32_768 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { model: string; source: string; context: number }
    expect(body).toEqual({ model: "openscience/llama3.1-ctx-32768", source: "llama3.1", context: 32_768 })
    expect(created.at(-1)).toEqual({
      model: "openscience/llama3.1-ctx-32768",
      from: "llama3.1",
      parameters: { num_ctx: 32_768 },
      stream: false,
    })
  })

  test("GET /status reports the auto-startable runtimes with boolean flags", async () => {
    const res = await app.request("/status")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runtimes: { id: string; installed: boolean; running: boolean }[] }
    expect(body.runtimes.map((r) => r.id).sort()).toEqual(["lmstudio", "ollama"])
    for (const rt of body.runtimes) {
      expect(typeof rt.installed).toBe("boolean")
      expect(typeof rt.running).toBe("boolean")
    }
  })

  test("POST /start on an unknown runtime is a 400", async () => {
    const res = await app.request("/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "not-a-runtime" }),
    })
    expect(res.status).toBe(400)
  })
})
