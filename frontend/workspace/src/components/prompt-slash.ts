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
