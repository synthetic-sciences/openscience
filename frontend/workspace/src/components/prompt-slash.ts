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
  type: "action" | "command" | "mode" | "skill"
  /** Local command-palette action. It executes in the client instead of being sent as a chat command. */
  actionID?: string
  /** Why a skill ranks above its neighbours. */
  skillState?: "loaded" | "pinned" | "recent" | "recommended"
  /** Subject metadata used by the shared skill-icon resolver. */
  skillCategory?: string
  skillTags?: readonly string[]
  /** Search-only text lets local actions survive the already-filtered list hook. */
  searchText?: string
  /** Section the row renders under. Empty for a flat result list. */
  group?: string
  /** Faint right-hand label; the subject of a library skill in search results. */
  meta?: string
  /** Position assigned by slashCatalog or slashMatches; the only sort key. */
  resultRank?: number
}

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

// The menu has three tiers. Core is the research agent's own toolkit: the
// two modes, the core skills in workflow order, and compaction. Session holds
// the rarer built-in actions. Everything else is the library, by subject.
export const SLASH_NATIVE = ["plan", "goal", "compact"] as const
export const SLASH_CONTEXTUAL = ["stop"] as const
export const SLASH_SESSION = ["stop", "init", "handoff", "checkpoint", "resume"] as const
export const SLASH_ACTION_SKILLS = ["init", "stop", "handoff", "checkpoint"] as const
export const SLASH_CORE = [
  "plan",
  "goal",
  "research-lookup",
  "literature-review",
  "brainstorming",
  "hypotheses",
  "reproduce",
  "autoresearch",
  "compute",
  "delegation",
  "figures",
  "schematics",
  "paper-writing",
  "ml-paper-writing",
  "citations",
  "peer-review",
  "sources",
  "compact",
] as const
export const SLASH_QUERY_LIMIT = 40

export const SLASH_GROUP_CORE = "Core"
export const SLASH_GROUP_PINNED = "Pinned"
export const SLASH_GROUP_SESSION = "Session"

export function slashActionSkill(name: string) {
  return (SLASH_ACTION_SKILLS as readonly string[]).includes(name)
}

export function slashCore(name: string) {
  return (SLASH_CORE as readonly string[]).includes(name)
}

export function slashGroup(command: SlashCommand) {
  return command.group ?? ""
}

export function slashMode(command: Pick<SlashCommand, "trigger">): SlashMode | undefined {
  if (command.trigger === "plan" || command.trigger === "goal") return command.trigger
}

export function sortSlash(a: SlashCommand, b: SlashCommand) {
  return (
    (a.resultRank ?? Number.MAX_SAFE_INTEGER) - (b.resultRank ?? Number.MAX_SAFE_INTEGER) ||
    a.trigger.localeCompare(b.trigger)
  )
}

const CORE_ICON = {
  plan: "branch",
  goal: "task",
  compact: "collapse",
  "research-lookup": "magnifying-glass",
  "literature-review": "book-open",
  brainstorming: "sparkles",
  hypotheses: "flask",
  reproduce: "refresh",
  autoresearch: "activity",
  compute: "cpu",
  delegation: "split",
  figures: "layout-grid",
  schematics: "photo",
  "paper-writing": "pencil-line",
  "ml-paper-writing": "file",
  citations: "bullet-list",
  "peer-review": "eye",
  sources: "shield",
  stop: "stop",
  init: "file",
  handoff: "arrow-right",
  checkpoint: "archive",
  resume: "bolt",
} as const

export function slashIcon(command: SlashCommand) {
  const fixed = CORE_ICON[command.trigger as keyof typeof CORE_ICON]
  if (fixed) return fixed
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

export function slashOptionId(command: Pick<SlashCommand, "id">) {
  return `composer-slash-option-${command.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

/** Sentence-case, single-line blurb for a row: the skill's summary when it
 * has one, otherwise the first sentence of its description. */
export function slashBlurb(text: string | undefined, limit = 120) {
  const first = (text ?? "").trim().split(/(?<=[.!?])\s+/)[0] ?? ""
  const cased = first ? first[0]!.toUpperCase() + first.slice(1) : ""
  const clean = cased.replace(/[.!]$/, "")
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean
}

export function slashSubject(category: string | undefined) {
  if (!category) return "Other"
  const words = category.replace(/[-_]+/g, " ").trim()
  if (/^(ml|llm|ai)\b/i.test(words)) return words.replace(/^(ml|llm|ai)\b/i, (m) => m.toUpperCase())
  return words[0]!.toUpperCase() + words.slice(1)
}

function matchScore(command: SlashCommand, query: string) {
  const needle = query.trim().replace(/^\/+/, "").toLowerCase()
  if (!needle) return 0
  const trigger = command.trigger.toLowerCase()
  const boost = slashCore(command.trigger) ? 40 : command.skillState ? 20 : 0
  if (trigger === needle) return 1_000 + boost
  if (trigger.startsWith(needle)) return 800 - trigger.length + boost
  if (trigger.includes(needle)) return 600 - trigger.indexOf(needle) + boost
  const text = [command.trigger, command.title, command.description, command.usage, command.searchText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  // Metadata matches start at a word so "cell" finds single-cell tools, not
  // every description that happens to mention Excel.
  const terms = needle.split(/\s+/).filter(Boolean)
  const starts = (term: string) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text)
  if (!terms.every(starts)) return 0
  return 300 + boost + terms.reduce((score, term) => score + (trigger.includes(term) ? 8 : 2), 0)
}

/** Rank a query against the whole menu. Results are one flat list, bounded
 * before Solid mounts rows, with the subject of a library skill as its meta. */
export function slashMatches(commands: readonly SlashCommand[], query: string, limit = SLASH_QUERY_LIMIT) {
  const needle = query.trim()
  if (!needle) return slashCatalog(commands)
  return commands
    .map((command) => ({ command, score: matchScore(command, needle) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || sortSlash(a.command, b.command))
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry.command,
      group: "",
      meta:
        entry.command.source === "skill" && !slashCore(entry.command.trigger)
          ? slashSubject(entry.command.skillCategory)
          : undefined,
      resultRank: index,
    }))
}

/** The full menu for a bare `/`: Core in workflow order, pinned skills, the
 * session actions, then the library by subject. Every row carries its group
 * and rank so the list hook only has to partition. */
export function slashCatalog(commands: readonly SlashCommand[]) {
  const byTrigger = new Map(commands.map((command) => [command.trigger, command]))
  const core = SLASH_CORE.map((name) => byTrigger.get(name)).filter((command): command is SlashCommand => !!command)
  const placed = new Set(core.map((command) => command.trigger))
  const pinned = commands
    .filter((command) => command.source === "skill" && command.skillState === "pinned" && !placed.has(command.trigger))
    .toSorted((a, b) => a.trigger.localeCompare(b.trigger))
  for (const command of pinned) placed.add(command.trigger)
  const session = SLASH_SESSION.map((name) => byTrigger.get(name)).filter(
    (command): command is SlashCommand => !!command && !placed.has(command.trigger),
  )
  for (const command of session) placed.add(command.trigger)
  const rest = commands.filter((command) => !placed.has(command.trigger))
  const library = rest
    .filter((command) => command.source === "skill")
    .toSorted(
      (a, b) =>
        slashSubject(a.skillCategory).localeCompare(slashSubject(b.skillCategory)) ||
        a.trigger.localeCompare(b.trigger),
    )
  const other = rest
    .filter((command) => command.source !== "skill")
    .toSorted((a, b) => a.trigger.localeCompare(b.trigger))

  const ordered: SlashCommand[] = [
    ...core.map((command) => ({ ...command, group: SLASH_GROUP_CORE })),
    ...pinned.map((command) => ({ ...command, group: SLASH_GROUP_PINNED })),
    ...[...session, ...other].map((command) => ({ ...command, group: SLASH_GROUP_SESSION })),
    ...library.map((command) => ({ ...command, group: slashSubject(command.skillCategory) })),
  ]
  return ordered.map((command, index) => ({ ...command, meta: undefined, resultRank: index }))
}

/** Groups keep the order their first row was given. */
export function sortSlashGroups(a: { items: SlashCommand[] }, b: { items: SlashCommand[] }) {
  return (a.items[0]?.resultRank ?? 0) - (b.items[0]?.resultRank ?? 0)
}
