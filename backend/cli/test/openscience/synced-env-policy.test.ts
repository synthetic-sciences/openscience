import { test, expect } from "bun:test"
import {
  isSyncedEnvAllowed,
  BLOCKED_SYNCED_ENV,
  RETIRED_SYNCED_COMPUTE_ENV_KEYS,
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

test("allows the OpenRouter managed route and non-compute integrations", () => {
  const allowed = [
    "OPENROUTER_API_KEY",
    "WANDB_API_KEY",
    "HF_TOKEN",
    "PINECONE_API_KEY",
    "GITHUB_TOKEN",
    "OPENALEX_API_KEY",
    "SEMANTIC_SCHOLAR_API_KEY",
    "NVIDIA_API_KEY",
  ]
  for (const key of allowed) {
    expect(isSyncedEnvAllowed(key)).toBe(true)
  }
  expect(isSyncedEnvAllowed("OPENROUTER_BASE_URL", managedOpenRouterBaseURL())).toBe(true)
  expect(SYNCED_SERVICE_ENV_KEYS).not.toContain("MODAL_TOKEN_SECRET")
})

test("fails closed for arbitrary environment fields and Modal control-plane tokens", () => {
  for (const key of ["PATH", "OPENSCIENCE_ARBITRARY_SYNC_VALUE", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]) {
    expect(isSyncedEnvAllowed(key, "account-value")).toBe(false)
  }
  expect(isSyncedEnvAllowed("OPENROUTER_BASE_URL")).toBe(false)
})

test("rejects every retired account-synced compute credential", () => {
  const retired = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_REGION",
    "AWS_REGION",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_OPENAI_API_KEY",
    "AZURE_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "TINKER_API_KEY",
    "TINKER_BASE_URL",
    "TENSORPOOL_KEY",
    "TENSORPOOL_API_KEY",
    "LAMBDA_API_KEY",
    "LAMBDA_LABS_API_KEY",
    "PRIME_API_KEY",
    "PRIME_INTELLECT_API_KEY",
    "VAST_API_KEY",
    "RUNPOD_API_KEY",
  ]

  expect([...RETIRED_SYNCED_COMPUTE_ENV_KEYS]).toEqual(retired)
  for (const key of retired) {
    expect(isSyncedEnvAllowed(key, "user-owned-but-account-synced")).toBe(false)
    expect(SYNCED_SERVICE_ENV_KEYS).not.toContain(key as never)
  }
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
