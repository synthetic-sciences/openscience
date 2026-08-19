import { canonicalKey } from "@/context/model-catalog"

export type ModelGroup =
  | "pinned"
  | "codex"
  | "openai"
  | "anthropic"
  | "google"
  | "kimi"
  | "deepseek"
  | "glm"
  | "xai"
  | "qwen"
  | "meta"
  | "mistral"
  | `provider:${string}`

export const MODEL_GROUPS: Array<{ id: ModelGroup; label: string }> = [
  { id: "pinned", label: "Quick access" },
  { id: "codex", label: "OpenAI Codex" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "kimi", label: "Kimi" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "glm", label: "GLM" },
  { id: "xai", label: "xAI" },
  { id: "qwen", label: "Qwen" },
  { id: "meta", label: "Meta" },
  { id: "mistral", label: "Mistral" },
]

type GroupModel = { id: string; provider: { id: string; name?: string } }

const title = (value: string) =>
  value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .replace(/^Openrouter$/i, "OpenRouter")

export function modelGroup(model: GroupModel, pinned = false): ModelGroup {
  if (pinned) return "pinned"
  if (model.provider.id === "openai-codex") return "codex"
  if (
    ["ollama", "lmstudio", "llamacpp", "vllm", "jan"].includes(model.provider.id) ||
    model.provider.id.startsWith("local-") ||
    model.provider.id.startsWith("ssh-")
  )
    return "provider:Local models"

  const key = canonicalKey(model.provider.id, model.id)
  if (key.startsWith("openai/")) return "openai"
  if (key.startsWith("anthropic/")) return "anthropic"
  if (key.startsWith("google/") || key.includes("/gemini-")) return "google"
  if (key.startsWith("moonshotai/") || key.includes("/kimi-")) return "kimi"
  if (key.startsWith("deepseek/") || key.includes("/deepseek-")) return "deepseek"
  if (key.startsWith("zai/") || key.includes("/glm-")) return "glm"
  if (key.startsWith("xai/") || key.includes("/grok-")) return "xai"
  if (key.startsWith("qwen/") || key.includes("/qwen-")) return "qwen"
  if (key.startsWith("meta/") || key.startsWith("meta-llama/") || key.includes("/llama-")) return "meta"
  if (key.startsWith("mistral/") || key.startsWith("mistralai/")) return "mistral"
  return `provider:${model.provider.name ?? model.provider.id}`
}

export function modelGroupLabel(group: ModelGroup) {
  const known = MODEL_GROUPS.find((item) => item.id === group)?.label
  if (known) return known
  return title(group.slice("provider:".length))
}

export function modelGroupRank(group: ModelGroup) {
  const rank = MODEL_GROUPS.findIndex((item) => item.id === group)
  return rank < 0 ? MODEL_GROUPS.length : rank
}

export function modelGroupLabelRank(label: string) {
  const rank = MODEL_GROUPS.findIndex((item) => item.label === label)
  return rank < 0 ? MODEL_GROUPS.length : rank
}
