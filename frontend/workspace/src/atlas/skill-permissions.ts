export type SkillPermissionAction = "allow" | "ask" | "deny"

type CatalogSkill = { name: string; entry?: boolean }

const isAction = (value: unknown): value is SkillPermissionAction =>
  value === "allow" || value === "ask" || value === "deny"

export function skillAction(permission: unknown, name: string): SkillPermissionAction {
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return "allow"
  const skill = (permission as Record<string, unknown>).skill
  if (isAction(skill)) return skill
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return "allow"
  const rules = skill as Record<string, unknown>
  const exact = rules[name]
  if (isAction(exact)) return exact
  const wildcard = rules["*"]
  return isAction(wildcard) ? wildcard : "allow"
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
  return visibleSkills(skills, reserved).filter((skill) => skillAction(permission, skill.name) !== "deny")
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
