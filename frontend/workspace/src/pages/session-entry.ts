export type SessionEntry = {
  id: string
  parentID?: string
  time?: {
    created?: number
    updated?: number
    archived?: number
  }
}

function activity(session: SessionEntry) {
  return session.time?.updated ?? session.time?.created ?? 0
}

/**
 * Resolve an unscoped project entry to an existing root conversation.
 * A remembered tab wins when it is still valid; otherwise resume the root
 * session with the latest activity. New research is an explicit fallback for
 * projects that do not have any resumable sessions.
 */
export function sessionEntryTarget(sessions: readonly SessionEntry[], remembered?: string) {
  const roots = sessions.filter((session) => !session.parentID && !session.time?.archived)
  if (remembered && roots.some((session) => session.id === remembered)) return remembered

  const recent = roots.reduce<SessionEntry | undefined>((current, session) => {
    if (!current) return session
    const difference = activity(session) - activity(current)
    if (difference !== 0) return difference > 0 ? session : current
    return session.id.localeCompare(current.id) > 0 ? session : current
  }, undefined)

  return recent?.id ?? "new"
}
