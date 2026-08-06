import { canonicalKey } from "@/context/model-catalog"

export type ModelGroup = "pinned" | "codex" | "anthropic" | "glm" | "openai" | "misc"

export const MODEL_GROUPS: Array<{ id: ModelGroup; label: string }> = [
  { id: "pinned", label: "Pinned" },
  { id: "codex", label: "OpenAI Codex subscription" },
  { id: "anthropic", label: "Anthropic" },
  { id: "glm", label: "GLM" },
  { id: "openai", label: "OpenAI" },
  { id: "misc", label: "Miscellaneous" },
]

type GroupModel = { id: string; provider: { id: string } }

export function modelGroup(model: GroupModel, pinned = false): ModelGroup {
  if (pinned) return "pinned"
  if (model.provider.id === "openai-codex") return "codex"

  const key = canonicalKey(model.provider.id, model.id)
  if (key.startsWith("anthropic/")) return "anthropic"
  if (key.startsWith("zai/") || key.includes("/glm-")) return "glm"
  if (key.startsWith("openai/")) return "openai"
  return "misc"
}

export function modelGroupLabel(group: ModelGroup) {
  return MODEL_GROUPS.find((item) => item.id === group)?.label ?? "Miscellaneous"
}

export function modelGroupRank(group: ModelGroup) {
  return MODEL_GROUPS.findIndex((item) => item.id === group)
}

export function modelGroupLabelRank(label: string) {
  const rank = MODEL_GROUPS.findIndex((item) => item.label === label)
  return rank < 0 ? MODEL_GROUPS.length : rank
}
