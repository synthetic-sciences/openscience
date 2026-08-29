import { skillIconFor } from "@/atlas/skill-icon"

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  usage?: string
  source: "builtin" | "project" | "mcp" | "skill"
  category: "session" | "research" | "evidence" | "output" | "project" | "skill"
  keybind?: string
  type: "action" | "browse" | "command" | "mode" | "skill"
  /** Local command-palette action. It executes in the client instead of being sent as a chat command. */
  actionID?: string
  /** Why a skill is in the compact empty-query shortlist. */
  skillState?: "loaded" | "pinned" | "recent" | "recommended"
  /** Subject metadata used by the shared skill-icon resolver. */
  skillCategory?: string
  skillTags?: readonly string[]
  /** Search-only text lets local actions survive the already-filtered list hook. */
  searchText?: string
  /** Ephemeral query rank assigned by slashMatches before grouped rendering. */
  resultRank?: number
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
export const SLASH_CONTEXTUAL = ["undo", "redo", "stop"] as const
export const SLASH_ACTION_SKILLS = ["init", "stop", "handoff", "checkpoint"] as const
export const SLASH_QUERY_LIMIT = 10
export const SLASH_SHORTLIST_LIMIT = 5

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
  if (command.resultRank !== undefined) return command.resultRank
  const core = SLASH_NATIVE.findIndex((name) => name === command.trigger)
  if (core >= 0) return core
  const contextual = SLASH_CONTEXTUAL.findIndex((name) => name === command.trigger)
  if (contextual >= 0) return 20 + contextual
  if (command.source === "builtin") return 100
  if (command.source === "project") return 200
  if (command.source === "mcp") return 300
  if (command.skillState === "loaded") return 350
  if (command.skillState === "pinned") return 360
  if (command.skillState === "recent") return 370
  if (command.skillState === "recommended") return 380
  if (command.type === "browse") return 500
  return 400
}

export function sortSlash(a: SlashCommand, b: SlashCommand) {
  return slashRank(a) - slashRank(b) || a.trigger.localeCompare(b.trigger)
}

export function slashIcon(command: SlashCommand) {
  if (command.type === "browse") return "layout-grid" as const
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
  if (command.source === "skill") {
    return skillIconFor({
      name: command.trigger,
      description: command.description,
      category: command.skillCategory,
      tags: command.skillTags,
    })
  }
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

export function slashState(command: SlashCommand) {
  if (command.skillState === "loaded") return "Loaded this turn"
  if (command.skillState === "pinned") return "Pinned"
  if (command.skillState === "recent") return "Recent"
  if (command.skillState === "recommended") return "Recommended"
  return slashSource(command)
}

export function slashOptionId(command: Pick<SlashCommand, "id">) {
  return `composer-slash-option-${command.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

function matchScore(command: SlashCommand, query: string) {
  const needle = query.trim().replace(/^\/+/, "").toLowerCase()
  if (!needle) return 0
  const trigger = command.trigger.toLowerCase()
  if (trigger === needle) return 1_000
  if (trigger.startsWith(needle)) return 800 - trigger.length
  if (trigger.includes(needle)) return 600 - trigger.indexOf(needle)
  const text = [command.trigger, command.title, command.description, command.usage]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  const terms = needle.split(/\s+/).filter(Boolean)
  if (!terms.every((term) => text.includes(term))) return 0
  return 300 + terms.reduce((score, term) => score + (trigger.includes(term) ? 8 : 2), 0)
}

/** Rank an already permission-filtered candidate set. The result is bounded
 * before Solid mounts rows, so opening `/` remains constant-cost even with a
 * library of hundreds of skills. */
export function slashMatches(commands: readonly SlashCommand[], query: string, limit = SLASH_QUERY_LIMIT) {
  const needle = query.trim()
  if (!needle) return commands.toSorted(sortSlash)
  return commands
    .map((command) => ({ command, score: matchScore(command, needle) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || sortSlash(a.command, b.command))
    .slice(0, limit)
    .map((entry, index) => ({ ...entry.command, resultRank: index }))
}

export function compactSlashItems(commands: readonly SlashCommand[], skillNames: ReadonlySet<string>) {
  return commands
    .filter(
      (command) =>
        SLASH_NATIVE.some((name) => name === command.trigger) ||
        SLASH_CONTEXTUAL.some((name) => name === command.trigger) ||
        (command.source === "skill" && skillNames.has(command.trigger)),
    )
    .toSorted(sortSlash)
}
