import { test, expect } from "bun:test"
import { isSyncedEnvAllowed, BLOCKED_SYNCED_ENV } from "../../src/openscience/synced-env-policy"

test("blocks every non-OpenRouter model-provider LLM credential (key + *_BASE_URL)", () => {
  const blocked = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
    "GOOGLE_API_KEY",
    "TOGETHER_API_KEY",
    "GROQ_API_KEY",
    "FIREWORKS_API_KEY",
    "XAI_API_KEY",
    // Derived from BYOK_LLM_ENV_KEYS — these three used to be missing from the
    // hand-maintained blocklist; deriving keeps them covered automatically.
    "MISTRAL_API_KEY",
    "MISTRAL_BASE_URL",
    "DEEPSEEK_API_KEY",
    "CEREBRAS_API_KEY",
  ]
  for (const key of blocked) {
    expect(isSyncedEnvAllowed(key)).toBe(false)
    expect(BLOCKED_SYNCED_ENV.has(key)).toBe(true)
  }
})

test("allows OpenRouter (the sole managed LLM route) and compute / ML-service keys", () => {
  const allowed = [
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "TINKER_API_KEY",
    "WANDB_API_KEY",
    "HF_TOKEN",
    "MODAL_TOKEN_ID",
    "LAMBDA_API_KEY",
    "PINECONE_API_KEY",
    "PATH",
  ]
  for (const key of allowed) {
    expect(isSyncedEnvAllowed(key)).toBe(true)
  }
})
