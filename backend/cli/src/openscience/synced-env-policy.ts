/**
 * Which Atlas-synced env vars the CLI is allowed to apply.
 *
 * OpenScience routes managed LLM calls through two explicit seams: OpenRouter
 * for the aggregated catalog, and Meta for Muse Spark. Both receive only an
 * Atlas `thk_*` token plus their Atlas proxy URL. Every other model provider
 * (Anthropic, OpenAI, Gemini, Together, Groq, Fireworks, xAI, Mistral,
 * DeepSeek, Cerebras, and Codex) is BYOK-only, configured locally with a shell
 * `export`,
 * `openscience keys add`, or Codex OAuth.
 *
 * Atlas still emits per-provider LLM credentials over `/api/cli/sync` for the
 * hosted web agents, so the CLI must drop them on its side. Without this a
 * dashboard-stored key (or its managed proxy token) synced into the process
 * would shadow the user's own local key — the exact bug this policy fixes.
 * Compute / ML-service integrations and OpenRouter are unaffected.
 *
 * Kept lightweight on purpose: imported by preload-env.ts, which runs its side
 * effect at module init before the rest of the app is loaded.
 */

import { managedApiBase } from "../endpoints"

/** The model-provider LLM env vars whose values are the user's OWN (BYOK)
 *  credential. Single source of truth — openscience/index.ts imports this for
 *  its subprocess-redaction set, and the sync blocklist below derives from it,
 *  so the two can never drift. OpenRouter is included (its own key is BYOK too)
 *  but the two managed-capable credentials are kept OUT of the blocklist. */
export const BYOK_LLM_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "META_MODEL_API_KEY",
  "TOGETHER_API_KEY",
  "GROQ_API_KEY",
  "FIREWORKS_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
]

const MANAGED_SYNCED_LLM_KEYS = new Set(["OPENROUTER_API_KEY", "META_MODEL_API_KEY"])
const MANAGED_SYNCED_BASE_URLS: Record<string, string> = {
  OPENROUTER_BASE_URL: "/api/llm/proxy/openrouter/",
  META_MODEL_BASE_URL: "/api/llm/proxy/meta/",
}

/** Match a proxy URL to the configured Atlas origin and an exact route prefix.
 * A path substring alone is not enough: an attacker-controlled origin could
 * otherwise place `/api/llm/proxy/` in its path and receive the scoped token. */
export function isAtlasProxyURL(
  value: unknown,
  route = "/api/llm/proxy/",
  atlasBase = managedApiBase(),
): value is string {
  if (typeof value !== "string") return false
  try {
    const candidate = new URL(value)
    const atlas = new URL(atlasBase)
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false
    if (candidate.origin !== atlas.origin) return false
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return false
    if (candidate.pathname.includes("%")) return false

    const basePath = atlas.pathname.replace(/\/+$/, "")
    const routePath = route.startsWith("/") ? route : `/${route}`
    const expected = `${basePath}${routePath}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "")
    return candidate.pathname === expected || candidate.pathname.startsWith(`${expected}/`)
  } catch {
    return false
  }
}

/** Env vars the CLI drops from Atlas sync: every BYOK model provider EXCEPT
 *  OpenRouter and Meta, each with its `*_BASE_URL` companion. Derived from
 *  BYOK_LLM_ENV_KEYS so a newly-added provider is covered automatically. */
export const BLOCKED_SYNCED_ENV = new Set<string>(
  BYOK_LLM_ENV_KEYS.filter((key) => !MANAGED_SYNCED_LLM_KEYS.has(key)).flatMap((key) => [
    key,
    key.replace(/_API_KEY$/, "_BASE_URL"),
  ]),
)

/** True when an Atlas-synced env var may be applied to the CLI process.
 *  OpenRouter + Meta managed routing vars and all compute / ML-service keys pass
 *  through; every other model-provider LLM credential is dropped because that
 *  provider is BYOK-local-only. */
export function isSyncedEnvAllowed(key: string, value?: string, atlasBase = managedApiBase()): boolean {
  if (BLOCKED_SYNCED_ENV.has(key)) return false
  // A managed provider secret delivered to the open-source client must be the
  // user's scoped Atlas token, never an upstream/shared provider credential.
  if (value !== undefined && MANAGED_SYNCED_LLM_KEYS.has(key)) return value.startsWith("thk_")
  // Likewise, managed routing may only target the provider-specific Atlas
  // proxy. A mismatched/public URL is dropped before it reaches process.env.
  const route = MANAGED_SYNCED_BASE_URLS[key]
  if (value !== undefined && route) return isAtlasProxyURL(value, route, atlasBase)
  return true
}
