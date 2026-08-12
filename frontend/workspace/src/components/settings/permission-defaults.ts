export type PermissionAction = "allow" | "ask" | "deny"
type PermissionObject = Record<string, PermissionAction>
type PermissionValue = PermissionAction | PermissionObject | string[] | undefined
type PermissionMap = Record<string, PermissionValue>

const VALID_ACTIONS = new Set<PermissionAction>(["allow", "ask", "deny"])

// Keep the Settings readout aligned with Agent's actual base rules. Most
// tools default to allow, but these two are explicitly ask-by-default in the
// backend. Showing Allow here when no user override existed made the panel
// contradict the permission engine until the user saved a value.
const RUNTIME_DEFAULTS: Partial<Record<string, PermissionAction>> = {
  external_directory: "ask",
  doom_loop: "ask",
}

export function permissionDefaultFor(id: string): PermissionAction {
  return RUNTIME_DEFAULTS[id] ?? "allow"
}

function getAction(value: unknown): PermissionAction | undefined {
  if (typeof value === "string" && VALID_ACTIONS.has(value as PermissionAction)) return value as PermissionAction
  return undefined
}

function ruleDefault(value: unknown): PermissionAction | undefined {
  const action = getAction(value)
  if (action) return action
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return getAction((value as Record<string, unknown>)["*"])
}

function toMap(value: unknown): PermissionMap {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as PermissionMap
  const action = getAction(value)
  return action ? { "*": action } : {}
}

export function permissionActionFor(permission: unknown, id: string): PermissionAction {
  const map = toMap(permission)
  return ruleDefault(map[id]) ?? ruleDefault(map["*"]) ?? permissionDefaultFor(id)
}

export function permissionChange(permission: unknown, id: string, action: PermissionAction) {
  const map = toMap(permission)
  const existing = map[id]
  const nextValue =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing, "*": action } : action
  return {
    optimistic: { ...map, [id]: nextValue },
    patch: { [id]: nextValue },
  }
}

export async function commitPermissionDefault(
  id: string,
  action: PermissionAction,
  hooks: {
    isBusy: () => boolean
    permission: () => unknown
    setPermission: (permission: unknown) => void
    setBusy: (busy: boolean) => void
    write: (patch: Record<string, PermissionValue>) => Promise<unknown>
  },
): Promise<{ ok: true } | { ok: false; busy: true } | { ok: false; error: string }> {
  if (hooks.isBusy()) return { ok: false, busy: true }
  const before = hooks.permission()
  const change = permissionChange(before, id, action)
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
