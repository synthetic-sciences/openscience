import { describe, expect, test } from "bun:test"
import { SandboxSettingsRoutes } from "../../src/server/routes/settings/sandbox"
import { Sandbox } from "../../src/sandbox/sandbox"

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
})
