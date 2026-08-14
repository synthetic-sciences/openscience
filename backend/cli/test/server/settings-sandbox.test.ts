import { describe, expect, test } from "bun:test"
import { SandboxSettingsRoutes } from "../../src/server/routes/settings/sandbox"
import { Sandbox } from "../../src/sandbox/sandbox"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const app = SandboxSettingsRoutes()
const configFiles = ["openscience.jsonc", "openscience.json", "config.json"].map((name) =>
  path.join(Global.Path.config, name),
)

async function snapshotGlobalConfig() {
  return Promise.all(
    configFiles.map(async (file) => ({
      file,
      content: await Bun.file(file)
        .text()
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return
          throw error
        }),
    })),
  )
}

async function restoreGlobalConfig(snapshot: Awaited<ReturnType<typeof snapshotGlobalConfig>>) {
  await Promise.all(
    snapshot.map(async (item) => {
      if (item.content === undefined) {
        await fs.rm(item.file, { force: true })
        return
      }
      await Bun.write(item.file, item.content)
    }),
  )
  Config.global.reset()
}

// GET / and POST /test are read-only / write-to-temp-only. The PUT regression
// snapshots and restores every candidate global config file byte-for-byte,
// including restoring absence, so it cannot leak config into another test.
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

  test("PUT persists the machine-wide explicit project-trust policy", async () => {
    const snapshot = await snapshotGlobalConfig()
    try {
      const response = await app.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireProjectTrust: true }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ config: { requireProjectTrust: true } })
      expect((await Config.trustedSandbox()).requireProjectTrust).toBe(true)
    } finally {
      await restoreGlobalConfig(snapshot)
    }
  })
})
