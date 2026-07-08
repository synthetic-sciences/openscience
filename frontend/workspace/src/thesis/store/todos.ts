import type { Message, Part, ToolPart, Todo } from "@synsci/sdk/v2"

export type TodoSummary = {
  items: Todo[]
  total: number
  completed: number
  active?: Todo
}

function todosFromPart(part: ToolPart): Todo[] {
  const state = part.state as { metadata?: { todos?: unknown }; input?: { todos?: unknown } }
  const meta = state?.metadata?.todos
  if (Array.isArray(meta)) return meta as Todo[]
  const input = state?.input?.todos
  if (Array.isArray(input)) return input as Todo[]
  return []
}

export function latestTodos(
  messages: Message[],
  partsByMessage: Record<string, Part[] | undefined>,
): TodoSummary | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== "assistant") continue
    const parts = partsByMessage[message.id]
    if (!parts) continue
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part?.type !== "tool" || (part as ToolPart).tool !== "todowrite") continue
      const items = todosFromPart(part as ToolPart)
      if (items.length === 0) return null
      const completed = items.filter((t) => t.status === "completed").length
      const active =
        items.find((t) => t.status === "in_progress") ??
        items.find((t) => t.status !== "completed" && t.status !== "cancelled")
      if (!active) return null
      return { items, total: items.length, completed, active }
    }
  }
  return null
}
