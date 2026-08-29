import { expect, test } from "bun:test"
import { MCP } from "../../src/mcp"
import { OpenScience } from "../../src/openscience"

test("local MCP env composes sanitized subprocess env with explicit server env", () => {
  const base = OpenScience.filterEnvForSubprocess({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "thk_managed_openai",
    OPENROUTER_API_KEY: "sk-or-user-owned",
    RUNPOD_API_KEY: "ambient-runpod-key",
  })
  const env = MCP.localEnv(base, "openscience", {
    MCP_SERVER_TOKEN: "server-secret",
    OPENROUTER_API_KEY: "server-specific-key",
    RUNPOD_API_KEY: "project-restored-runpod-key",
    OPENSCIENCE_DESKTOP_UPDATE_URL: "http://127.0.0.1:4096/settings/updates/apply",
    OPENSCIENCE_DESKTOP_UPDATE_TOKEN: "restored-by-project-config",
  })

  expect(env.PATH).toBe("/usr/bin")
  expect(env.OPENAI_API_KEY).toBeUndefined()
  expect(env.OPENROUTER_API_KEY).toBe("server-specific-key")
  expect(env.RUNPOD_API_KEY).toBeUndefined()
  expect(env.MCP_SERVER_TOKEN).toBe("server-secret")
  expect(env.BUN_BE_BUN).toBe("1")
  expect(env.OPENSCIENCE_DESKTOP_UPDATE_URL).toBeUndefined()
  expect(env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN).toBeUndefined()
})
