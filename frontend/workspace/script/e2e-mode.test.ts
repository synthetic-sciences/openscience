import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { E2E_MODE_ENV, externalRunnerEnvironment, playwrightCommand, resolvePlaywrightTarget } from "./e2e-mode"

describe("E2E command selection", () => {
  test("runs isolated seed setup under the exact Bun executing the harness", () => {
    const harness = readFileSync(fileURLToPath(new URL("./e2e-local.ts", import.meta.url)), "utf8")
    expect(harness).toContain('Bun.spawn([process.execPath, "script/seed-e2e.ts"]')
    expect(harness).not.toContain('Bun.spawn(["bun", "script/seed-e2e.ts"]')
    expect(harness).toContain("OPENSCIENCE_E2E_RUNTIME: process.execPath")
    expect(harness).toContain("SYNSC_API_BASE: `http://127.0.0.1:${modelPort}`")
  })

  test("package scripts make the isolated free-port harness the default", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>
    }

    expect(pkg.scripts.test).toBe("bun script/e2e-local.ts")
    expect(pkg.scripts["test:e2e"]).toBe("bun script/e2e-local.ts")
    expect(pkg.scripts["test:e2e:local"]).toBe("bun script/e2e-local.ts")
    expect(pkg.scripts["test:e2e:external"]).toBe("bun script/e2e-external.ts")
    expect(pkg.scripts["test:e2e:packaged"]).toBe("bun script/e2e-external.ts --packaged")
  })

  test("raw Playwright configuration is rejected without an explicit mode", () => {
    expect(() => resolvePlaywrightTarget({})).toThrow(`Set ${E2E_MODE_ENV}=isolated`)
  })

  test("isolated mode ignores a stale ambient base URL and never reuses its port", () => {
    const target = resolvePlaywrightTarget({
      [E2E_MODE_ENV]: "isolated",
      PLAYWRIGHT_PORT: "43123",
      PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3000",
    })

    expect(target).toEqual({
      mode: "isolated",
      baseURL: "http://127.0.0.1:43123",
      startWebServer: true,
      reuseExistingServer: false,
      port: 43123,
    })
  })

  test("external mode is explicit, requires a URL, and never starts Vite", () => {
    expect(() => resolvePlaywrightTarget({ [E2E_MODE_ENV]: "external" })).toThrow(
      "External E2E mode requires PLAYWRIGHT_BASE_URL",
    )
    expect(
      resolvePlaywrightTarget({ [E2E_MODE_ENV]: "external", PLAYWRIGHT_BASE_URL: "http://localhost:4112" }),
    ).toEqual({
      mode: "external",
      baseURL: "http://localhost:4112/",
      startWebServer: false,
      reuseExistingServer: false,
    })
  })

  test("packaged runner derives the API address from the explicit base URL", () => {
    const env = externalRunnerEnvironment({ PLAYWRIGHT_BASE_URL: "https://package.test:8443/ui" }, true)
    expect(env[E2E_MODE_ENV]).toBe("external")
    expect(env.PLAYWRIGHT_SERVER_HOST).toBe("package.test")
    expect(env.PLAYWRIGHT_SERVER_PORT).toBe("8443")
    expect(env.OPENSCIENCE_E2E_PACKAGED).toBe("1")
  })

  test("raw Playwright invocation has one non-recursive command", () => {
    expect(playwrightCommand(["--grep", "settings"]).slice(1)).toEqual([
      "x",
      "playwright",
      "test",
      "--grep",
      "settings",
    ])
  })
})
