export type SkillPermissionAction = "allow" | "ask" | "deny"

export type CatalogSkill = {
  name: string
  entry?: boolean
  permission_action?: SkillPermissionAction
  recommended?: boolean
}

export interface SkillCatalogSnapshot<T extends CatalogSkill> {
  library: T[]
  allowed: T[]
  pinned: T[]
  recent: T[]
  recommended: T[]
  loadedThisTurn: T[]
  shortlist: T[]
  action: (name: string) => SkillPermissionAction
}

export interface SkillPreferences {
  pinned: string[]
  recent: string[]
}

export const SKILL_PREFERENCES_EVENT = "openscience:skill-preferences"
export const SKILL_PINNED_KEY = "openscience.skills.pinned.v1"
export const SKILL_RECENT_KEY = "openscience.skills.recent.v1"
const RECENT_LIMIT = 8

const isAction = (value: unknown): value is SkillPermissionAction =>
  value === "allow" || value === "ask" || value === "deny"

export function skillAction(
  permission: unknown,
  name: string,
  fallback: SkillPermissionAction = "allow",
): SkillPermissionAction {
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return fallback
  const skill = (permission as Record<string, unknown>).skill
  if (isAction(skill)) return skill
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return fallback
  const rules = skill as Record<string, unknown>
  const exact = rules[name]
  if (isAction(exact)) return exact
  const wildcard = rules["*"]
  return isAction(wildcard) ? wildcard : fallback
}

export function visibleSkills<T extends CatalogSkill>(skills: readonly T[], reserved: Iterable<string>) {
  const names = new Set(reserved)
  return skills.filter((skill) => {
    if (skill.entry === false || names.has(skill.name)) return false
    names.add(skill.name)
    return true
  })
}

export function enabledSkills<T extends CatalogSkill>(
  skills: readonly T[],
  reserved: Iterable<string>,
  permission: unknown,
) {
  return visibleSkills(skills, reserved).filter(
    (skill) => skillAction(permission, skill.name, skill.permission_action ?? "allow") !== "deny",
  )
}

function uniqueNames(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter(
    (name): name is string => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name),
  )
}

function readNames(storage: Pick<Storage, "getItem"> | undefined, key: string) {
  if (!storage) return []
  try {
    return uniqueNames(JSON.parse(storage.getItem(key) ?? "[]"))
  } catch {
    return []
  }
}

export function skillPreferences(storage: Pick<Storage, "getItem"> | undefined): SkillPreferences {
  return {
    pinned: readNames(storage, SKILL_PINNED_KEY),
    recent: readNames(storage, SKILL_RECENT_KEY),
  }
}

function writeNames(storage: Pick<Storage, "setItem"> | undefined, key: string, names: string[]) {
  storage?.setItem(key, JSON.stringify(names))
  if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
    globalThis.dispatchEvent(new CustomEvent(SKILL_PREFERENCES_EVENT))
  }
  return names
}

export function recordRecentSkill(
  name: string,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  limit = RECENT_LIMIT,
) {
  const next = [name, ...readNames(storage, SKILL_RECENT_KEY).filter((item) => item !== name)].slice(0, limit)
  return writeNames(storage, SKILL_RECENT_KEY, next)
}

export function setSkillPinned(
  name: string,
  pinned: boolean,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
) {
  const current = readNames(storage, SKILL_PINNED_KEY).filter((item) => item !== name)
  return writeNames(storage, SKILL_PINNED_KEY, pinned ? [name, ...current] : current)
}

function selectNames<T extends CatalogSkill>(allowed: T[], names: readonly string[]) {
  const index = new Map(allowed.map((skill) => [skill.name, skill]))
  return names.flatMap((name) => {
    const skill = index.get(name)
    return skill ? [skill] : []
  })
}

export function skillCatalogSnapshot<T extends CatalogSkill>(
  skills: readonly T[],
  options: {
    permission?: unknown
    reserved?: Iterable<string>
    pinned?: readonly string[]
    recent?: readonly string[]
    loadedThisTurn?: readonly string[]
    shortlistLimit?: number
  } = {},
): SkillCatalogSnapshot<T> {
  const library = visibleSkills(skills, options.reserved ?? [])
  const actions = new Map(
    library.map((skill) => [
      skill.name,
      skillAction(options.permission, skill.name, skill.permission_action ?? "allow"),
    ]),
  )
  const action = (name: string) => actions.get(name) ?? "deny"
  const allowed = library.filter((skill) => action(skill.name) !== "deny")
  const pinned = selectNames(allowed, options.pinned ?? [])
  const recent = selectNames(allowed, options.recent ?? [])
  const loadedThisTurn = selectNames(allowed, options.loadedThisTurn ?? [])
  const recommended = allowed.filter((skill) => skill.recommended)
  const shortlist = [...pinned, ...recent, ...recommended]
    .filter((skill, index, all) => all.findIndex((item) => item.name === skill.name) === index)
    .slice(0, options.shortlistLimit ?? 5)

  return { library, allowed, pinned, recent, recommended, loadedThisTurn, shortlist, action }
}

type TurnMessage = { id: string; role: string }
type TurnToolPart = {
  type: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }
}

/** Read completed Skill-tool calls after the latest user message. This is a UI
 * state only; it never grants authority or persists across turns. */
export function loadedSkillNamesThisTurn(
  messages: readonly TurnMessage[],
  parts: Readonly<Record<string, readonly TurnToolPart[] | undefined>>,
) {
  const start = messages.findLastIndex((message) => message.role === "user")
  if (start < 0) return []
  const names: string[] = []
  for (const message of messages.slice(start)) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== "tool" || part.tool !== "skill" || part.state?.status !== "completed") continue
      const value = part.state.metadata?.name ?? part.state.input?.name
      if (typeof value !== "string" || !value.trim() || names.includes(value)) continue
      names.push(value)
    }
  }
  return names
}

export function skillPermissionChange(permission: unknown, name: string, enabled: boolean) {
  const base = permission && typeof permission === "object" && !Array.isArray(permission) ? permission : {}
  const existing = (base as Record<string, unknown>).skill
  const rules: Record<string, SkillPermissionAction> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, SkillPermissionAction>)
      : isAction(existing)
        ? { "*": existing }
        : {}
  const skill = { ...rules, [name]: enabled ? ("allow" as const) : ("deny" as const) }
  return {
    optimistic: { ...(base as Record<string, unknown>), skill },
    patch: { skill },
  }
}

/** Restore one exact rule without erasing newer optimistic changes. */
export function restoreExactSkillPermission(current: unknown, before: unknown, name: string) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {}
  const currentSkill = (base as Record<string, unknown>).skill
  const rules: Record<string, SkillPermissionAction> =
    currentSkill && typeof currentSkill === "object" && !Array.isArray(currentSkill)
      ? { ...(currentSkill as Record<string, SkillPermissionAction>) }
      : isAction(currentSkill)
        ? { "*": currentSkill }
        : {}

  const previousSkill =
    before && typeof before === "object" && !Array.isArray(before)
      ? (before as Record<string, unknown>).skill
      : undefined
  const previousRules =
    previousSkill && typeof previousSkill === "object" && !Array.isArray(previousSkill)
      ? (previousSkill as Record<string, unknown>)
      : undefined
  const previousExact = previousRules?.[name]

  if (isAction(previousExact)) rules[name] = previousExact
  else delete rules[name]

  return { ...(base as Record<string, unknown>), skill: rules } as Record<string, unknown> & {
    skill: Record<string, SkillPermissionAction>
  }
}

export async function commitSkillPermission(
  name: string,
  enabled: boolean,
  hooks: {
    isBusy: () => boolean
    permission: () => unknown
    setPermission: (permission: unknown) => void
    setBusy: (busy: boolean) => void
    write: (patch: Record<string, unknown>) => Promise<unknown>
  },
): Promise<{ ok: true } | { ok: false; busy: true } | { ok: false; error: string }> {
  // updateConfig patches permission state, but a failed optimistic write has
  // to restore a whole snapshot. Serialize toggles so that rollback can never
  // erase a different skill change that completed in the meantime.
  if (hooks.isBusy()) return { ok: false, busy: true }
  const before = hooks.permission()
  const change = skillPermissionChange(before, name, enabled)
  hooks.setBusy(true)
  hooks.setPermission(change.optimistic)
  try {
    await hooks.write(change.patch)
    return { ok: true }
  } catch (error) {
    hooks.setPermission(before)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    hooks.setBusy(false)
  }
}
