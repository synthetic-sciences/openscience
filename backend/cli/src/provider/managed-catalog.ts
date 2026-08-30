/** Reviewed Ace roster shipped with the client. No dashboard sync is required. */
export const MANAGED_OPENROUTER_MODELS = Object.freeze([
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "anthropic/claude-opus-5",
  "anthropic/claude-fable-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.7-flash",
  "x-ai/grok-4.6",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3.8-max",
  "qwen/qwen3.8-flash",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.7-code",
  "minimax/minimax-m3",
  "meta/muse-spark-1.2",
  "nvidia/nemotron-3-ultra-550b-a55b",
] as const)

export const MANAGED_OPENROUTER_MODEL_SET = new Set<string>(MANAGED_OPENROUTER_MODELS)

type ManagedModel = {
  name: string
  context: number
  output: number
  input: readonly ("text" | "image" | "video" | "audio" | "pdf")[]
  temperature?: boolean
}

// Verified against https://openrouter.ai/api/v1/models on 2026-08-30.
// Runtime metadata supplies prices for the actual upstream route; this fallback
// only keeps model identity and token budgeting usable when models.dev lags.
export const MANAGED_MODEL_DETAILS: Record<(typeof MANAGED_OPENROUTER_MODELS)[number], ManagedModel> = {
  "openai/gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    context: 1_050_000,
    output: 128_000,
    input: ["text", "image", "pdf"],
    temperature: false,
  },
  "openai/gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    context: 1_050_000,
    output: 128_000,
    input: ["text", "image", "pdf"],
    temperature: false,
  },
  "openai/gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    context: 1_050_000,
    output: 128_000,
    input: ["text", "image", "pdf"],
    temperature: false,
  },
  "anthropic/claude-opus-5": {
    name: "Claude Opus 5",
    context: 1_000_000,
    output: 128_000,
    input: ["text", "image", "pdf"],
    temperature: false,
  },
  "anthropic/claude-fable-5": {
    name: "Claude Fable 5",
    context: 1_000_000,
    output: 128_000,
    input: ["text", "image", "pdf"],
    temperature: false,
  },
  "anthropic/claude-sonnet-5": {
    name: "Claude Sonnet 5",
    context: 1_000_000,
    output: 128_000,
    input: ["text", "image", "pdf"],
    temperature: false,
  },
  "anthropic/claude-haiku-4.5": {
    name: "Claude Haiku 4.5",
    context: 200_000,
    output: 64_000,
    input: ["text", "image", "pdf"],
  },
  "google/gemini-3.1-pro-preview": {
    name: "Gemini 3.1 Pro Preview",
    context: 1_048_576,
    output: 65_536,
    input: ["text", "image", "video", "audio", "pdf"],
  },
  "google/gemini-3.7-flash": {
    name: "Gemini 3.7 Flash",
    context: 1_048_576,
    output: 65_536,
    input: ["text", "image", "video", "audio", "pdf"],
    temperature: false,
  },
  "x-ai/grok-4.6": { name: "Grok 4.6", context: 500_000, output: 450_000, input: ["text", "image", "pdf"] },
  "z-ai/glm-5.3": { name: "GLM 5.3", context: 1_310_720, output: 131_072, input: ["text"] },
  "z-ai/glm-5.3-flash": {
    name: "GLM 5.3 Flash",
    context: 1_310_720,
    output: 131_072,
    input: ["text", "image", "video"],
  },
  "deepseek/deepseek-v4-pro": { name: "DeepSeek V4 Pro", context: 1_048_576, output: 384_000, input: ["text"] },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", context: 1_048_576, output: 384_000, input: ["text"] },
  "qwen/qwen3.8-max": { name: "Qwen 3.8 Max", context: 1_000_000, output: 131_072, input: ["text", "image", "video"] },
  // Official Flash-Next production API: https://qwen.ai/blog?id=qwen3.8-flash-next
  "qwen/qwen3.8-flash": {
    name: "Qwen 3.8 Flash Next",
    context: 1_000_000,
    output: 131_072,
    input: ["text", "image", "video"],
  },
  "moonshotai/kimi-k3": { name: "Kimi K3", context: 1_048_576, output: 943_718, input: ["text", "image", "video"] },
  "moonshotai/kimi-k2.7-code": { name: "Kimi K2.7 Code", context: 262_144, output: 235_929, input: ["text", "image"] },
  "minimax/minimax-m3": { name: "MiniMax M3", context: 1_048_576, output: 512_000, input: ["text", "image", "video"] },
  "meta/muse-spark-1.2": {
    name: "Muse Spark 1.2",
    context: 1_048_576,
    output: 943_718,
    input: ["text", "image", "video", "audio", "pdf"],
  },
  "nvidia/nemotron-3-ultra-550b-a55b": { name: "Nemotron 3 Ultra", context: 262_144, output: 16_384, input: ["text"] },
}

export function managedModelDetails(modelID: string): ManagedModel | undefined {
  if (!MANAGED_OPENROUTER_MODEL_SET.has(modelID)) return undefined
  return MANAGED_MODEL_DETAILS[modelID as keyof typeof MANAGED_MODEL_DETAILS]
}
