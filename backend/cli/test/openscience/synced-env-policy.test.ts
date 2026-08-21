import { test, expect } from "bun:test"
import {
  isSyncedEnvAllowed,
  BLOCKED_SYNCED_ENV,
  SYNCED_SERVICE_ENV_KEYS,
  managedOpenRouterBaseURL,
} from "../../src/openscience/synced-env-policy"

test("allows user-owned provider keys and blocks synced provider base URLs", () => {
  const keys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "TOGETHER_API_KEY",
    "GROQ_API_KEY",
    "FIREWORKS_API_KEY",
    "XAI_API_KEY",
    "META_MODEL_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "CEREBRAS_API_KEY",
    "PERPLEXITY_API_KEY",
  ]
  for (const key of keys) {
    expect(isSyncedEnvAllowed(key, "user-owned-key")).toBe(true)
    expect(isSyncedEnvAllowed(key, "thk_managed")).toBe(false)
    expect(isSyncedEnvAllowed(key, "thk-codex-oauth-placeholder")).toBe(false)
    expect(BLOCKED_SYNCED_ENV.has(key)).toBe(false)

    const base = key.replace(/_API_KEY$/, "_BASE_URL")
    expect(isSyncedEnvAllowed(base, "https://provider.test/v1")).toBe(false)
    expect(BLOCKED_SYNCED_ENV.has(base)).toBe(true)
  }
})

test("allows the OpenRouter managed route and compute / ML-service keys", () => {
  const allowed = [
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "TINKER_API_KEY",
    "WANDB_API_KEY",
    "HF_TOKEN",
    "MODAL_TOKEN_ID",
    "LAMBDA_API_KEY",
    "PINECONE_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_CLIENT_SECRET",
    "GITHUB_TOKEN",
    "OPENALEX_API_KEY",
    "SEMANTIC_SCHOLAR_API_KEY",
    "NVIDIA_API_KEY",
    "PATH",
  ]
  for (const key of allowed) {
    expect(isSyncedEnvAllowed(key)).toBe(true)
  }
  expect(SYNCED_SERVICE_ENV_KEYS).toContain("RUNPOD_API_KEY")
  expect(SYNCED_SERVICE_ENV_KEYS).not.toContain("MODAL_TOKEN_SECRET")
})

test("OpenRouter accepts BYOK or managed keys but only the matching Atlas proxy URL", () => {
  const atlasBase = "https://atlas.test"
  expect(isSyncedEnvAllowed("OPENROUTER_API_KEY", "thk_user.scoped")).toBe(true)
  expect(isSyncedEnvAllowed("OPENROUTER_API_KEY", "sk-or-user-owned")).toBe(true)
  expect(managedOpenRouterBaseURL(atlasBase)).toBe("https://atlas.test/api/llm/proxy/openrouter/v1")
  expect(isSyncedEnvAllowed("OPENROUTER_BASE_URL", "https://atlas.test/api/llm/proxy/openrouter/v1", atlasBase)).toBe(
    true,
  )
  expect(isSyncedEnvAllowed("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1", atlasBase)).toBe(false)
  expect(
    isSyncedEnvAllowed(
      "OPENROUTER_BASE_URL",
      "https://evil.test/https://atlas.test/api/llm/proxy/openrouter/v1",
      atlasBase,
    ),
  ).toBe(false)
  expect(
    isSyncedEnvAllowed("OPENROUTER_BASE_URL", "https://atlas.test.evil.test/api/llm/proxy/openrouter/v1", atlasBase),
  ).toBe(false)
  expect(
    isSyncedEnvAllowed("OPENROUTER_BASE_URL", "https://atlas.test/api/llm/proxy/openrouter/%2e%2e/meta", atlasBase),
  ).toBe(false)
})
