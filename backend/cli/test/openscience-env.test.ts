import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { OpenScience } from "../src/openscience"
import { ToolOutputPath } from "../src/tool/tool-output-path"

test("structured credentials are redacted before registered secret substrings", () => {
  const suffix = createHash("sha256").update("openscience-redaction-suffix").digest("hex")
  const prefix = createHash("sha256").update("openscience-redaction-prefix").digest("hex").slice(0, 10)
  const epoch = createHash("sha256").update("openscience-redaction-epoch").digest("hex").slice(0, 32)
  const nonce = createHash("sha256").update("openscience-redaction-nonce").digest("hex").slice(0, 32)
  const proof = `odp_v2.${prefix}.${epoch}.${nonce}.${suffix}`
  OpenScience.registerSecretValues([suffix])

  expect(OpenScience.redactSecrets(`before x${proof}x after`)).toBe("before x[REDACTED]x after")
})

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

test("subprocess env filtering never exposes compute or desktop control-plane capabilities", () => {
  const filtered = OpenScience.filterEnvForSubprocess({
    PATH: "/usr/bin",
    MODAL_TOKEN_ID: "ak-user-owned",
    MODAL_TOKEN_SECRET: "as-user-owned",
    OPENSCIENCE_DESKTOP_UPDATE_URL: "http://127.0.0.1:4096/settings/updates/apply",
    OPENSCIENCE_DESKTOP_UPDATE_TOKEN: "desktop-update-capability",
    LAMBDA_API_KEY: "lambda-user-owned",
    RUNPOD_API_KEY: "runpod-user-owned",
  })

  expect(filtered).toEqual({ PATH: "/usr/bin" })
})

test("control-plane filtering denies the complete desktop update namespace after environment overlays", () => {
  const filtered = OpenScience.filterControlPlaneEnv({
    PATH: "/usr/bin",
    OPENSCIENCE_DESKTOP_UPDATE_URL: "http://127.0.0.1:4096/settings/updates/apply",
    OPENSCIENCE_DESKTOP_UPDATE_TOKEN: "desktop-update-capability",
    OPENSCIENCE_DESKTOP_UPDATE_FUTURE_CAPABILITY: "must-default-deny",
    PROJECT_AUTHORED_VALUE: "preserved",
  })

  expect(filtered).toEqual({
    PATH: "/usr/bin",
    PROJECT_AUTHORED_VALUE: "preserved",
  })
})

test("representative agent subprocess environments cannot inherit host control-plane capabilities", () => {
  const ambient = {
    PATH: "/usr/bin",
    HOME: "/home/researcher",
    TENSORPOOL_KEY: "tensorpool-host-capability",
    LAMBDA_API_KEY: "lambda-host-capability",
    PRIME_API_KEY: "prime-host-capability",
    VAST_API_KEY: "vast-host-capability",
    RUNPOD_API_KEY: "runpod-host-capability",
    OPENSCIENCE_DESKTOP_UPDATE_URL: "http://127.0.0.1:4096/settings/updates/apply",
    OPENSCIENCE_DESKTOP_UPDATE_TOKEN: "desktop-update-capability",
  }
  const sanitized = OpenScience.filterEnvForSubprocess(ambient)
  const environments: Record<string, Record<string, string>> = {
    bashAfterRuntimeOverlay: OpenScience.filterEnvForSubprocess({
      ...sanitized,
      OPENSCIENCE_DESKTOP_UPDATE_TOKEN: "restored-by-runtime-overlay",
    }),
    taskShell: { ...sanitized, TERM: "dumb" },
    localCompute: sanitized,
    kernel: OpenScience.kernelEnv(ambient, {
      OPENSCIENCE_DESKTOP_UPDATE_URL: "restored-by-kernel-overlay",
      OPENSCIENCE_DESKTOP_UPDATE_TOKEN: "restored-by-kernel-overlay",
    }),
  }

  for (const environment of Object.values(environments)) {
    expect(environment.TENSORPOOL_KEY).toBeUndefined()
    expect(environment.LAMBDA_API_KEY).toBeUndefined()
    expect(environment.PRIME_API_KEY).toBeUndefined()
    expect(environment.VAST_API_KEY).toBeUndefined()
    expect(environment.RUNPOD_API_KEY).toBeUndefined()
    expect(environment.OPENSCIENCE_DESKTOP_UPDATE_URL).toBeUndefined()
    expect(environment.OPENSCIENCE_DESKTOP_UPDATE_TOKEN).toBeUndefined()
  }
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
