import { expect, test } from "bun:test"
import { OpenScience } from "../src/openscience"

test("subprocess env filtering never passes managed Atlas provider keys", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    PATH: "/usr/bin",
    OPENROUTER_API_KEY: "thk_managed_openrouter",
    OPENAI_API_KEY: "thk_managed_openai",
    OPENROUTER_BASE_URL: "https://atlas.test/api/llm/proxy/openrouter/v1",
  })

  expect(filtered.PATH).toBe("/usr/bin")
  expect(filtered.OPENROUTER_API_KEY).toBeUndefined()
  expect(filtered.OPENAI_API_KEY).toBeUndefined()
  expect(filtered.OPENROUTER_BASE_URL).toBe("https://atlas.test/api/llm/proxy/openrouter/v1")
})

test("subprocess env filtering still passes BYOK OpenRouter keys", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    OPENROUTER_API_KEY: "sk-or-user-owned",
  })

  expect(filtered.OPENROUTER_API_KEY).toBe("sk-or-user-owned")
})

test("mergeByokEnv injects a locally-connected OpenRouter key + pins public base url", () => {
  const merged = OpenScience.mergeByokEnv(
    { PATH: "/usr/bin", OPENROUTER_BASE_URL: "https://atlas.test/api/llm/proxy/openrouter/v1" },
    { openrouter: { type: "api", key: "sk-or-user-owned" } },
  )

  expect(merged.OPENROUTER_API_KEY).toBe("sk-or-user-owned")
  // A bridged BYOK key must hit public OpenRouter, not the managed proxy.
  expect(merged.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1")
})

test("mergeByokEnv never injects a managed thk_ key", () => {
  const merged = OpenScience.mergeByokEnv({}, { openrouter: { type: "api", key: "thk_managed" } })
  expect(merged.OPENROUTER_API_KEY).toBeUndefined()
})

test("mergeByokEnv does not override an existing value", () => {
  const merged = OpenScience.mergeByokEnv(
    { OPENROUTER_API_KEY: "sk-or-from-shell" },
    { openrouter: { type: "api", key: "sk-or-from-auth" } },
  )
  expect(merged.OPENROUTER_API_KEY).toBe("sk-or-from-shell")
})

test("mergeByokEnv ignores providers that are not subprocess-safe", () => {
  const merged = OpenScience.mergeByokEnv({}, { anthropic: { type: "api", key: "sk-ant-user" } })
  expect(merged.ANTHROPIC_API_KEY).toBeUndefined()
})
