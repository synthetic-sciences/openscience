import { managedApiBase } from "../endpoints"

/** User-owned credentials that approved local subprocesses may receive. */
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

/** User-owned routing overrides paired with direct-provider credentials. */
export const BYOK_LLM_BASE_URL_KEYS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "GOOGLE_BASE_URL",
  "GEMINI_BASE_URL",
  "OPENROUTER_BASE_URL",
  "META_MODEL_BASE_URL",
  "TOGETHER_BASE_URL",
  "GROQ_BASE_URL",
  "FIREWORKS_BASE_URL",
  "XAI_BASE_URL",
  "MISTRAL_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "CEREBRAS_BASE_URL",
  "PERPLEXITY_BASE_URL",
]

/** User-owned service credentials that approved local subprocesses may receive. */
export const SYNCED_SERVICE_ENV_KEYS = [
  "NVIDIA_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENALEX_MAILTO",
  "OPENALEX_API_KEY",
  "SEMANTIC_SCHOLAR_API_KEY",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "WANDB_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_TRACING",
  "PINECONE_API_KEY",
] as const

/** Device-local compute credentials are injected only by the selected adapter. */
export const LOCAL_COMPUTE_CLI_ENV_KEYS = [
  "TENSORPOOL_KEY",
  "TENSORPOOL_API_KEY",
  "LAMBDA_API_KEY",
  "LAMBDA_LABS_API_KEY",
  "PRIME_API_KEY",
  "PRIME_INTELLECT_API_KEY",
  "VAST_API_KEY",
  "RUNPOD_API_KEY",
] as const

export function managedOpenRouterBaseURL(atlasBase = managedApiBase()): string {
  return `${atlasBase.replace(/\/+$/, "")}/api/llm/proxy/openrouter/v1`
}

/** Exact managed-proxy origin and path validation; lookalike origins fail. */
export function isAtlasProxyURL(
  value: unknown,
  route = "/api/llm/proxy/",
  atlasBase = managedApiBase(),
): value is string {
  if (typeof value !== "string") return false
  try {
    const candidate = new URL(value)
    const atlas = new URL(atlasBase)
    if ((candidate.protocol !== "http:" && candidate.protocol !== "https:") || candidate.origin !== atlas.origin)
      return false
    if (
      candidate.username ||
      candidate.password ||
      candidate.search ||
      candidate.hash ||
      candidate.pathname.includes("%")
    )
      return false
    const basePath = atlas.pathname.replace(/\/+$/, "")
    const routePath = route.startsWith("/") ? route : `/${route}`
    const expected = `${basePath}${routePath}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "")
    return candidate.pathname === expected || candidate.pathname.startsWith(`${expected}/`)
  } catch {
    return false
  }
}
