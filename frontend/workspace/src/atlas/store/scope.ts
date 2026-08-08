const FALLBACK_PROJECT = "__workspace__"
const FALLBACK_SESSION = "new"

function clean(value: string, fallback: string) {
  const next = value.trim()
  return next || fallback
}

export function workspaceScope(project: string, session: string) {
  return `${encodeURIComponent(clean(project, FALLBACK_PROJECT))}:${encodeURIComponent(clean(session, FALLBACK_SESSION))}`
}

export function projectScope(project: string) {
  return encodeURIComponent(clean(project, FALLBACK_PROJECT))
}

export function defaultWorkspaceScope() {
  return projectScope(FALLBACK_PROJECT)
}
