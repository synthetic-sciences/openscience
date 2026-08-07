export const MODEL_PROVIDERS = [
  { id: "anthropic", atlas: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
  { id: "openai", atlas: "openai", label: "OpenAI", placeholder: "sk-…" },
  { id: "google", atlas: "gemini", label: "Google Gemini", placeholder: "AIza…" },
  { id: "xai", atlas: "xai", label: "xAI", placeholder: "xai-…" },
  { id: "meta", atlas: "meta", label: "Meta Model API", placeholder: "meta-…" },
  { id: "openrouter", atlas: "openrouter", label: "OpenRouter", placeholder: "sk-or-…" },
  { id: "togetherai", atlas: "together", label: "Together AI", placeholder: "…" },
  { id: "groq", atlas: "groq", label: "Groq", placeholder: "gsk_…" },
  { id: "fireworks-ai", atlas: "fireworks", label: "Fireworks AI", placeholder: "fw_…" },
  { id: "mistral", atlas: "mistral", label: "Mistral", placeholder: "…" },
  { id: "deepseek", atlas: "deepseek", label: "DeepSeek", placeholder: "sk-…" },
  { id: "moonshotai", atlas: "moonshot", label: "Moonshot AI (Kimi)", placeholder: "sk-…" },
  { id: "zai", atlas: "zai", label: "Z.AI (GLM)", placeholder: "…" },
  { id: "cerebras", atlas: "cerebras", label: "Cerebras", placeholder: "csk-…" },
  { id: "perplexity", atlas: "perplexity", label: "Perplexity", placeholder: "pplx-…" },
] as const

export const MODEL_PROVIDER_LABELS = Object.fromEntries(
  MODEL_PROVIDERS.map((provider) => [provider.id, provider.label]),
) as Record<string, string>

export function modelProvider(id: string) {
  return MODEL_PROVIDERS.find((provider) => provider.id === id) ?? MODEL_PROVIDERS[0]
}
