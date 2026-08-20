export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  usage?: string
  source: "builtin" | "project" | "mcp" | "skill"
  category: "session" | "research" | "evidence" | "output" | "project" | "skill"
  keybind?: string
  type: "action" | "command" | "skill"
}

export type SlashGroup = "Commands" | "Skills"

export const SLASH_CORE = ["goals", "compact", "review", "plan"] as const

export function slashGroup(command: SlashCommand): SlashGroup {
  return SLASH_CORE.some((name) => name === command.trigger) ? "Commands" : "Skills"
}

export function slashRank(command: SlashCommand) {
  const core = SLASH_CORE.findIndex((name) => name === command.trigger)
  if (core >= 0) return core
  if (command.source === "builtin") return 100
  if (command.source === "project") return 200
  if (command.source === "mcp") return 300
  return 400
}

export function sortSlash(a: SlashCommand, b: SlashCommand) {
  return slashRank(a) - slashRank(b) || a.trigger.localeCompare(b.trigger)
}

export function slashIcon(command: SlashCommand) {
  if (command.trigger === "goals") return "task" as const
  if (command.trigger === "compact") return "collapse" as const
  if (command.trigger === "review") return "eye" as const
  if (command.trigger === "plan") return "branch" as const
  if (command.trigger === "verify") return "circle-check" as const
  if (command.trigger === "status") return "activity" as const
  if (command.trigger === "context") return "book-open" as const
  if (command.trigger === "stop") return "stop" as const
  if (command.trigger === "checkpoint") return "archive" as const
  if (command.trigger === "reproduce") return "refresh" as const
  if (command.trigger === "compare") return "branch" as const
  if (command.trigger === "sources") return "book-open" as const
  if (command.trigger === "export") return "download" as const
  if (command.trigger === "handoff") return "arrow-right" as const
  if (command.type === "skill") return "flask" as const
  if (command.source === "mcp") return "mcp" as const
  if (command.category === "research") return "research" as const
  if (command.category === "evidence") return "artifact" as const
  if (command.category === "output") return "download" as const
  return "bolt" as const
}

export function slashSource(command: SlashCommand) {
  if (SLASH_CORE.some((name) => name === command.trigger)) return ""
  if (command.source === "builtin") return "Built in"
  if (command.source === "project") return "Project"
  if (command.source === "mcp") return "MCP"
  return "Skill"
}
