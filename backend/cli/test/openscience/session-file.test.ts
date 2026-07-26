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
    await OpenScience.saveSession({ api_key: "thk_test.secret", user_id: "u1", device_name: "dev" })
    const s = await OpenScience.getSession()
    expect(s?.api_key).toBe("thk_test.secret")
    expect(s?.user_id).toBe("u1")

    const atlasConfigPath = process.env["ATLAS_CLI_CONFIG_PATH"]
    expect(atlasConfigPath).toBeTruthy()
    expect(atlasConfigPath).toContain("openscience-test-data-")
    const atlasConfig = JSON.parse(await fs.readFile(atlasConfigPath!, "utf8"))
    expect(atlasConfig.profiles.default).toMatchObject({
      api_key: "thk_test.secret",
      base_url: "http://127.0.0.1:9/api/v1",
    })

    await OpenScience.clearSession()
    expect(await OpenScience.getSession()).toBeNull()
  })

  test("a session without an api_key is treated as no session", async () => {
    await OpenScience.saveSession({ api_key: "", user_id: "u1" } as any)
    expect(await OpenScience.getSession()).toBeNull()
    await OpenScience.clearSession()
  })
})
