/**
 * Which Atlas-synced env vars the CLI is allowed to apply.
 *
 * OpenScience routes every *managed* LLM call through OpenRouter — that is the
 * one provider the Atlas wallet pays for, via the proxy `OPENROUTER_BASE_URL` +
 * a `thk_*` `OPENROUTER_API_KEY`. Every other model provider (Anthropic, OpenAI,
 * Gemini, Together, Groq, Fireworks, xAI, Mistral, DeepSeek, Cerebras, and
 * Codex) is BYOK-only, configured locally with a shell `export`,
 * `openscience keys add`, or Codex OAuth.
 *
 * Atlas still emits per-provider LLM credentials over `/api/cli/sync` for the
 * hosted web agents, so the CLI must drop them on its side. Without this a
 * dashboard-stored key (or its managed proxy token) synced into the process
 * would shadow the user's own local key — the exact bug this policy fixes.
 * Compute / ML-service integrations and OpenRouter are unaffected.
 *
 * Kept dependency-free on purpose: imported by preload-env.ts, which runs its
 * side effect at module init before the rest of the app is loaded.
 */

/** The model-provider LLM env vars whose values are the user's OWN (BYOK)
 *  credential. Single source of truth — openscience/index.ts imports this for
 *  its subprocess-redaction set, and the sync blocklist below derives from it,
 *  so the two can never drift. OpenRouter is included (its own key is BYOK too)
 *  but kept OUT of the blocklist since it is the one managed-capable provider. */
export const BYOK_LLM_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "GROQ_API_KEY",
  "FIREWORKS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
]

/** Env vars the CLI drops from Atlas sync: every BYOK model provider EXCEPT
 *  OpenRouter, each with its `*_BASE_URL` companion. Derived from
 *  BYOK_LLM_ENV_KEYS so a newly-added provider is covered automatically. */
export const BLOCKED_SYNCED_ENV = new Set<string>(
  BYOK_LLM_ENV_KEYS.filter((key) => key !== "OPENROUTER_API_KEY").flatMap((key) => [
    key,
    key.replace(/_API_KEY$/, "_BASE_URL"),
  ]),
)

/** True when an Atlas-synced env var may be applied to the CLI process.
 *  OpenRouter (the sole managed LLM route) and all compute / ML-service keys
 *  pass through; every other model-provider LLM credential is dropped because
 *  that provider is BYOK-local-only. */
export function isSyncedEnvAllowed(key: string): boolean {
  return !BLOCKED_SYNCED_ENV.has(key)
}
