import { describe, expect, test } from "bun:test"
import { SandboxSettingsRoutes } from "../../src/server/routes/settings/sandbox"
import { Sandbox } from "../../src/sandbox/sandbox"
import os from "node:os"
import path from "node:path"

const app = SandboxSettingsRoutes()

// GET / and POST /test are read-only / write-to-temp-only, so these never touch
// the real global config (PUT does — that path is covered by the CLI e2e).
describe("/settings/sandbox routes", () => {
  test("GET / reports backend availability and a config object", async () => {
    const res = await app.request("/")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      config: object
      status: { platform: string; backend: string; available: boolean }
    }
    expect(typeof body.config).toBe("object")
    expect(body.status.platform).toBe(process.platform)
    expect(body.status.backend).toBe(Sandbox.backend())
    expect(typeof body.status.available).toBe("boolean")
  })

  test("POST /test runs the self-test and returns per-check results", async () => {
    const res = await app.request("/test", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      backend: string
      available: boolean
      ok: boolean
      checks: { name: string; pass: boolean }[]
    }
    expect(body.available).toBe(Sandbox.available())
    expect(typeof body.ok).toBe("boolean")
    if (body.available) {
      // Containment must actually hold on a machine that has a backend.
      expect(body.checks.length).toBeGreaterThanOrEqual(2)
      expect(body.checks.some((c) => /inside/.test(c.name))).toBe(true)
      expect(body.checks.some((c) => /outside/.test(c.name))).toBe(true)
      expect(body.ok).toBe(true)
    }
  })

  test("PUT rejects non-absolute and over-broad writable roots without persisting them", async () => {
    const before = await (await app.request("/")).json()
    for (const value of ["relative/path", "/", os.homedir(), path.dirname(os.homedir())]) {
      const response = await app.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowWrite: [value] }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("invalid or over-broad") })
    }
    expect(await (await app.request("/")).json()).toEqual(before)
  })
})
