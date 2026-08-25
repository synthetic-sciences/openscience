export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  usage?: string
  source: "builtin" | "project" | "mcp" | "skill"
  category: "session" | "research" | "evidence" | "output" | "project" | "skill"
  keybind?: string
  type: "action" | "command" | "mode" | "skill"
  /** Local command-palette action. It executes in the client instead of being sent as a chat command. */
  actionID?: string
}

export type SlashGroup = "Commands" | "Skills"
export type SlashMode = "plan" | "goal"

export interface SlashToken {
  query: string
  start: number
  end: number
  inline: boolean
}

export interface SlashEdit {
  content: string
  cursor: number
  start: number
  end: number
  value: string
}

/** Find the slash token immediately before the caret, wherever it appears. */
export function slashTokenAt(text: string, cursor: number): SlashToken | undefined {
  const end = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, end)
  const match = before.match(/(?:^|[\s([{])\/([a-z0-9_-]*)$/i)
  if (!match) return
  const start = before.lastIndexOf("/")
  return {
    query: match[1],
    start,
    end,
    inline: text.slice(0, start).trim().length > 0 || text.slice(end).trim().length > 0,
  }
}

/** Replace the slash token at the caret without disturbing the surrounding draft. */
export function slashEdit(text: string, cursor: number, value: string): SlashEdit | undefined {
  const token = slashTokenAt(text, cursor)
  if (!token) return

  const after = text[token.end]
  const before = text[token.start - 1]
  const trimsAfter = !!after && /\s/.test(after) && (value.length === 0 || /\s$/.test(value))
  const trimsBefore = value.length === 0 && token.end === text.length && !!before && /\s/.test(before)
  const start = trimsBefore ? token.start - 1 : token.start
  const end = trimsAfter ? token.end + 1 : token.end

  return {
    content: text.slice(0, start) + value + text.slice(end),
    cursor: start + value.length,
    start,
    end,
    value,
  }
}

// Keep the native surface intentionally small. Everything that is an optional
// workflow belongs in the toggleable Skills section instead of masquerading as
// an app command.
export const SLASH_NATIVE = ["compact", "context", "plan", "goal", "status"] as const
export const SLASH_ACTION_SKILLS = ["init", "stop", "handoff", "checkpoint"] as const

export function slashActionSkill(name: string) {
  return (SLASH_ACTION_SKILLS as readonly string[]).includes(name)
}

export function slashGroup(command: SlashCommand): SlashGroup {
  return command.source === "skill" ? "Skills" : "Commands"
}

export function slashMode(command: Pick<SlashCommand, "trigger">): SlashMode | undefined {
  if (command.trigger === "plan" || command.trigger === "goal") return command.trigger
}

export function slashRank(command: SlashCommand) {
  const core = SLASH_NATIVE.findIndex((name) => name === command.trigger)
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
  if (command.trigger === "goal") return "task" as const
  if (command.trigger === "init") return "file" as const
  if (command.trigger === "compact") return "collapse" as const
  if (command.trigger === "review") return "eye" as const
  if (command.trigger === "plan") return "branch" as const
  if (command.trigger === "verify") return "circle-check" as const
  if (command.trigger === "status") return "activity" as const
  if (command.trigger === "context") return "book-open" as const
  if (command.trigger === "undo" || command.trigger === "redo") return "refresh" as const
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
  if (command.source === "builtin") return "Built in"
  if (command.source === "project") return "Project"
  if (command.source === "mcp") return "MCP"
  return ""
}
