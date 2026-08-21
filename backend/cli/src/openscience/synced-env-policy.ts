/**
 * Which Atlas-synced env vars the CLI is allowed to apply.
 *
 * OpenScience routes managed LLM calls through one explicit seam: OpenRouter
 * for the aggregated catalog. It receives only an Atlas `thk_*` token plus
 * the Atlas proxy URL. User-owned provider keys saved in Atlas are also synced
 * into the matching OpenScience provider env var. Explicit shell and project
 * env values retain precedence over the synced copy.
 *
 * Kept lightweight on purpose: imported by preload-env.ts, which runs its side
 * effect at module init before the rest of the app is loaded.
 */

import { managedApiBase } from "../endpoints"
import { isAtlasManagedKey } from "../credentials/managed-key"

/** The model-provider LLM env vars whose values are the user's OWN (BYOK)
 *  credential. Single source of truth — openscience/index.ts imports this for
 *  its subprocess-redaction and passthrough sets so they cannot drift. */
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
  "PERPLEXITY_API_KEY",
]

/** Atlas-synced non-model credentials that approved agent subprocesses may
 * consume. Modal stays outside this list because its token resolves only in the
 * trusted compute adapter. */
export const SYNCED_SERVICE_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "NVIDIA_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENALEX_MAILTO",
  "OPENALEX_API_KEY",
  "SEMANTIC_SCHOLAR_API_KEY",
  "TINKER_API_KEY",
  "TINKER_BASE_URL",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "WANDB_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_TRACING",
  "PINECONE_API_KEY",
  "TENSORPOOL_API_KEY",
  "LAMBDA_API_KEY",
  "PRIME_INTELLECT_API_KEY",
  "VAST_API_KEY",
  "RUNPOD_API_KEY",
] as const

const MANAGED_SYNCED_LLM_KEYS = new Set(["OPENROUTER_API_KEY"])
const MANAGED_SYNCED_BASE_URLS: Record<string, string> = {
  OPENROUTER_BASE_URL: "/api/llm/proxy/openrouter/",
}

export function managedOpenRouterBaseURL(atlasBase = managedApiBase()): string {
  return `${atlasBase.replace(/\/+$/, "")}/api/llm/proxy/openrouter/v1`
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

/** Provider base URLs are never imported from the dashboard. BYOK keys always
 *  target OpenScience's built-in public endpoints, while the one managed route
 *  is validated separately below. */
export const BLOCKED_SYNCED_ENV = new Set<string>(
  BYOK_LLM_ENV_KEYS.filter((key) => !MANAGED_SYNCED_LLM_KEYS.has(key)).map((key) =>
    key.replace(/_API_KEY$/, "_BASE_URL"),
  ),
)

/** True when an Atlas-synced env var may be applied to the CLI process.
 *  User-owned BYOK keys, the validated OpenRouter managed route, and compute /
 *  ML-service keys pass through. A scoped Atlas token is never accepted under
 *  a direct provider's env var. */
export function isSyncedEnvAllowed(key: string, value?: string, atlasBase = managedApiBase()): boolean {
  if (BLOCKED_SYNCED_ENV.has(key)) return false
  if (isAtlasManagedKey(value) && !MANAGED_SYNCED_LLM_KEYS.has(key)) return false
  // Likewise, managed routing may only target the provider-specific Atlas
  // proxy. A mismatched/public URL is dropped before it reaches process.env.
  const route = MANAGED_SYNCED_BASE_URLS[key]
  if (value !== undefined && route) return isAtlasProxyURL(value, route, atlasBase)
  return true
}
