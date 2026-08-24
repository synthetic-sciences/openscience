import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { OpenScience } from "../../src/openscience"

// Test env is XDG-isolated (see test/preload.ts), so the session file lives in a
// throwaway dir and starts absent.

describe("OpenScience session file", () => {
  test("getSession returns null when no session file exists (real logout)", async () => {
    await OpenScience.clearSession()
    expect(await OpenScience.getSession()).toBeNull()
    expect(await OpenScience.isAuthenticated()).toBe(false)
  })

  test("saveSession then getSession round-trips atomically", async () => {
    const atlasConfigPath = process.env["ATLAS_CLI_CONFIG_PATH"]
    expect(atlasConfigPath).toBeTruthy()
    expect(atlasConfigPath).toContain("openscience-test-data-")
    await fs.rm(atlasConfigPath!, { force: true })

    await OpenScience.saveSession({ api_key: "thk_test.secret", user_id: "u1", device_name: "dev" })
    const s = await OpenScience.getSession()
    expect(s?.api_key).toBe("thk_test.secret")
    expect(s?.user_id).toBe("u1")

    expect(await fs.stat(atlasConfigPath!).catch(() => null)).toBeNull()

    await OpenScience.clearSession()
    expect(await OpenScience.getSession()).toBeNull()
  })

  test("saveSession updates an existing legacy companion config without replacing its settings", async () => {
    const atlasConfigPath = process.env["ATLAS_CLI_CONFIG_PATH"]!
    await fs.writeFile(
      atlasConfigPath,
      JSON.stringify({
        active_profile: "work",
        theme: "dark",
        profiles: {
          default: { api_key: "thk_old.secret", base_url: "https://old.example/api/v1", label: "legacy" },
          work: { api_key: "thk_work.secret", base_url: "https://work.example/api/v1" },
        },
      }),
      { mode: 0o600 },
    )

    await OpenScience.saveSession({ api_key: "thk_test.secret", user_id: "u1", device_name: "dev" })

    const atlasConfig = JSON.parse(await fs.readFile(atlasConfigPath, "utf8"))
    expect(atlasConfig).toMatchObject({ active_profile: "work", theme: "dark" })
    expect(atlasConfig.profiles.default).toMatchObject({
      api_key: "thk_test.secret",
      base_url: "http://127.0.0.1:9/api/v1",
      label: "legacy",
    })
    expect(atlasConfig.profiles.work).toMatchObject({ api_key: "thk_work.secret" })

    await OpenScience.clearSession()
    expect(await OpenScience.getSession()).toBeNull()
    await fs.rm(atlasConfigPath, { force: true })
  })

  test("a session without an api_key is treated as no session", async () => {
    await OpenScience.saveSession({ api_key: "", user_id: "u1" } as any)
    expect(await OpenScience.getSession()).toBeNull()
    await OpenScience.clearSession()
  })
})
