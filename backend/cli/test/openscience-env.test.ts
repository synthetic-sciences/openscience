import { expect, test } from "bun:test"
import path from "node:path"
import { OpenScience } from "../src/openscience"
import { ToolOutputPath } from "../src/tool/tool-output-path"

test("subprocess env filtering never passes managed Atlas provider keys", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    PATH: "/usr/bin",
    OPENROUTER_API_KEY: "thk_managed_openrouter",
    OPENAI_API_KEY: "thk_managed_openai",
    OPENROUTER_BASE_URL: "https://atlas.test/api/llm/proxy/openrouter/v1",
    META_MODEL_API_KEY: "thk_managed_meta",
    META_MODEL_BASE_URL: "https://atlas.test/api/llm/proxy/meta/v1",
    XAI_API_KEY: "xai-user-owned",
  })

  expect(filtered.PATH).toBe("/usr/bin")
  expect(filtered.OPENROUTER_API_KEY).toBeUndefined()
  expect(filtered.OPENAI_API_KEY).toBeUndefined()
  expect(filtered.META_MODEL_API_KEY).toBeUndefined()
  expect(filtered.XAI_API_KEY).toBe("xai-user-owned")
  expect(filtered.OPENROUTER_BASE_URL).toBe("https://atlas.test/api/llm/proxy/openrouter/v1")
  expect(filtered.META_MODEL_BASE_URL).toBe("https://atlas.test/api/llm/proxy/meta/v1")
})

test("subprocess env filtering still passes BYOK OpenRouter keys", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    OPENROUTER_API_KEY: "sk-or-user-owned",
  })

  expect(filtered.OPENROUTER_API_KEY).toBe("sk-or-user-owned")
})

test("subprocess env filtering repins BYOK away from an inherited Atlas proxy", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    OPENROUTER_API_KEY: "sk-or-user-owned",
    OPENROUTER_BASE_URL: "https://atlas.test/api/llm/proxy/openrouter/v1",
  })

  expect(filtered.OPENROUTER_API_KEY).toBe("sk-or-user-owned")
  expect(filtered.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1")
})

test("subprocess env filtering preserves a BYOK custom gateway", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    OPENROUTER_API_KEY: "sk-or-user-owned",
    OPENROUTER_BASE_URL: "https://my-gateway.example/api/v1",
  })

  expect(filtered.OPENROUTER_BASE_URL).toBe("https://my-gateway.example/api/v1")
})

test("subprocess env filtering preserves direct shell credentials but never exposes Modal tokens", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    PATH: "/usr/bin",
    MODAL_TOKEN_ID: "ak-user-owned",
    MODAL_TOKEN_SECRET: "as-user-owned",
    LAMBDA_API_KEY: "lambda-user-owned",
    RUNPOD_API_KEY: "runpod-user-owned",
  })

  expect(filtered).toEqual({
    PATH: "/usr/bin",
    LAMBDA_API_KEY: "lambda-user-owned",
    RUNPOD_API_KEY: "runpod-user-owned",
  })
})

test("kernel env filtering keeps runtime configuration but drops credentials", () => {
  const filtered = OpenScience.filterEnvForKernel({
    PATH: "/usr/bin",
    HOME: "/home/researcher",
    LANG: "en_US.UTF-8",
    VIRTUAL_ENV: "/work/.venv",
    PYTHONPATH: "/work/python",
    R_LIBS: "/work/R",
    ATLAS_API_KEY: "thk_atlas",
    OPENROUTER_API_KEY: "sk-or-user-owned",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    PRIVATE_RESEARCH_TOKEN: "private-secret",
  })

  expect(filtered).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/researcher",
    LANG: "en_US.UTF-8",
    VIRTUAL_ENV: "/work/.venv",
    PYTHONPATH: "/work/python",
    R_LIBS: "/work/R",
  })
})

test("kernel subprocesses cannot fall back to host Git config or credential prompts", () => {
  const env = OpenScience.kernelEnv({ PATH: "/usr/bin", HOME: "/home/researcher" })
  expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
  expect(env.GIT_TERMINAL_PROMPT).toBe("0")
})

test("kernel credential mask covers Atlas and OpenScience credential stores", () => {
  const paths = OpenScience.kernelSensitivePaths()
  const names = paths.map((value) => path.basename(value))
  expect(names).toContain("openscience-session.json")
  expect(names).toContain("openscience-workspace-scope.json")
  expect(names).toContain("auth.json")
  expect(names).toContain("credentials.json")
  expect(names).toContain("mcp-auth.json")
  expect(paths).toContain(ToolOutputPath.root)
  expect(names).toContain(".ssh")
  expect(names).toContain(".aws")
  expect(names).toContain(".netrc")
  expect(names).toContain(".git-credentials")
  expect(paths).toContain(
    process.env.ATLAS_CLI_CONFIG_PATH || path.join(process.env.HOME!, ".config", "atlas-cli", "config.json"),
  )
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

test("mergeByokEnv repairs an existing BYOK key paired with the managed proxy", () => {
  const merged = OpenScience.mergeByokEnv(
    {
      OPENROUTER_API_KEY: "sk-or-from-shell",
      OPENROUTER_BASE_URL: "https://app.syntheticsciences.ai/api/llm/proxy/openrouter/v1",
    },
    {},
  )

  expect(merged.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1")
})

test("mergeByokEnv supports the canonical direct-provider set and aliases", () => {
  const merged = OpenScience.mergeByokEnv(
    {},
    {
      anthropic: { type: "api", key: "sk-ant-user" },
      google: { type: "api", key: "google-user" },
      togetherai: { type: "api", key: "together-user" },
      "fireworks-ai": { type: "api", key: "fireworks-user" },
      deepseek: { type: "api", key: "deepseek-user" },
      perplexity: { type: "api", key: "perplexity-user" },
    },
  )

  expect(merged.ANTHROPIC_API_KEY).toBe("sk-ant-user")
  expect(merged.GOOGLE_GENERATIVE_AI_API_KEY).toBe("google-user")
  expect(merged.GOOGLE_API_KEY).toBe("google-user")
  expect(merged.GEMINI_API_KEY).toBe("google-user")
  expect(merged.TOGETHER_API_KEY).toBe("together-user")
  expect(merged.FIREWORKS_API_KEY).toBe("fireworks-user")
  expect(merged.DEEPSEEK_API_KEY).toBe("deepseek-user")
  expect(merged.PERPLEXITY_API_KEY).toBe("perplexity-user")
})
