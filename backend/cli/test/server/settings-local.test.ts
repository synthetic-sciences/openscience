import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { LocalModelsRoutes } from "../../src/server/routes/settings/local"

const app = LocalModelsRoutes()

// A real in-process OpenAI-compatible mock server so these tests never touch the
// global fetch (which would race with other test files) or the network.
let server: ReturnType<typeof Bun.serve>
let mockBase = ""
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "llama3.1" }, { id: "qwen2.5" }] })
      return new Response("not found", { status: 404 })
    },
  })
  mockBase = `http://127.0.0.1:${server.port}/v1`
})
afterAll(() => server?.stop(true))

describe("/settings/local routes", () => {
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
