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
