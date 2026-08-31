import type { CatalogSkill } from "./skill-permissions"

export type SkillView = "all" | "active" | "pinned" | "off"
export type SkillDensity = "comfortable" | "compact"

/** Selection is independent of permission: activating never grants allow. */
export function skillSelection(disabled: readonly string[], names: readonly string[], enabled: boolean) {
  const changed = new Set(names)
  return [...new Set([...disabled.filter((name) => !changed.has(name)), ...(enabled ? [] : names)])]
}

export function selectedSkills<T extends CatalogSkill>(
  skills: readonly T[],
  options: { view: SkillView; pinned: ReadonlySet<string>; active: ReadonlySet<string> },
) {
  return skills.filter((skill) => {
    if (options.view === "pinned") return options.pinned.has(skill.name)
    if (options.view === "active") return options.active.has(skill.name)
    if (options.view === "off") return !options.active.has(skill.name)
    return true
  })
}

export function skillCatalogKey(server: string) {
  return `openscience.skills.catalog.v2:${encodeURIComponent(server.replace(/\/+$/, ""))}`
}

export function skillDensity(storage: Pick<Storage, "getItem"> | undefined): SkillDensity {
  try {
    return storage?.getItem("openscience.skills.density.v1") === "compact" ? "compact" : "comfortable"
  } catch {
    return "comfortable"
  }
}
