import type { CatalogSkill } from "./skill-permissions"

export type SkillView = "all" | "core" | "library" | "personal" | "off"

/** Selection is independent of permission: activating never grants allow. */
export function skillSelection(disabled: readonly string[], names: readonly string[], enabled: boolean) {
  const changed = new Set(names)
  return [...new Set([...disabled.filter((name) => !changed.has(name)), ...(enabled ? [] : names)])]
}

export type SkillSource = "default" | "installed" | "user" | "project"

export function skillSource(skill: { origin?: SkillSource; location: string }): SkillSource {
  if (skill.origin) return skill.origin
  const location = skill.location.toLowerCase()
  if (location.includes("installed-skills") || location.includes(".claude/skills")) return "installed"
  if (location.includes("user-skills")) return "user"
  if (location.includes(".openscience/")) return "project"
  return "default"
}

export function coreSkill(skill: { category?: string }) {
  return skill.category === "core"
}

/** Core skills follow the research workflow, the order the / menu uses too. */
export const CORE_SKILL_ORDER = [
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
] as const

export function compareCore(a: { name: string }, b: { name: string }) {
  const left = CORE_SKILL_ORDER.indexOf(a.name as (typeof CORE_SKILL_ORDER)[number])
  const right = CORE_SKILL_ORDER.indexOf(b.name as (typeof CORE_SKILL_ORDER)[number])
  if (left >= 0 && right >= 0) return left - right
  if (left >= 0) return -1
  if (right >= 0) return 1
  return a.name.localeCompare(b.name)
}

export function selectedSkills<T extends CatalogSkill & { category?: string; origin?: SkillSource; location: string }>(
  skills: readonly T[],
  options: { view: SkillView; active: ReadonlySet<string> },
) {
  return skills.filter((skill) => {
    if (options.view === "core") return coreSkill(skill)
    if (options.view === "library") return !coreSkill(skill) && skillSource(skill) === "default"
    if (options.view === "personal") return skillSource(skill) !== "default"
    if (options.view === "off") return !options.active.has(skill.name)
    return true
  })
}

export function skillCatalogKey(server: string) {
  return `openscience.skills.catalog.v2:${encodeURIComponent(server.replace(/\/+$/, ""))}`
}
