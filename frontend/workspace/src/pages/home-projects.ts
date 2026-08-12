export type ProjectRecord = {
  id: string
  worktree: string
  name?: string
  time: {
    created: number
    updated?: number
  }
}

export type PreparedProject = ProjectRecord & {
  updatedAt: number
  pinned: boolean
}

export type LauncherState = "loading" | "error" | "empty" | "recent"

const timestamp = (project: ProjectRecord) => project.time.updated ?? project.time.created ?? 0

function folderName(worktree: string) {
  if (worktree === "/") return "/"
  const parts = worktree.split("/").filter(Boolean)
  return parts.at(-1) ?? worktree
}

function readable(value: string | undefined) {
  const text = value?.trim()
  if (!text || /[\p{Cc}\p{Cs}\uFFFD]/u.test(text)) return
  return text
}

export function projectName(project: ProjectRecord) {
  return readable(project.name) || readable(folderName(project.worktree)) || "Untitled project"
}

export function prepareProjects(
  projects: ProjectRecord[],
  hidden: ReadonlySet<string>,
  favorites: ReadonlySet<string> = new Set(),
) {
  const indexed = projects.reduce((result, project) => {
    if (!project.id || !project.worktree || hidden.has(project.id) || hidden.has(project.worktree)) return result
    const current = result.get(project.id)
    if (current && timestamp(current) >= timestamp(project)) return result
    result.set(project.id, project)
    return result
  }, new Map<string, ProjectRecord>())

  return Array.from(indexed.values())
    .map(
      (project): PreparedProject => ({
        ...project,
        updatedAt: timestamp(project),
        pinned: favorites.has(project.id) || favorites.has(project.worktree),
      }),
    )
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)
}

export function filterProjects(projects: PreparedProject[], query: string) {
  const term = query.trim().toLocaleLowerCase()
  if (!term) return projects
  return projects.filter((project) => {
    const searchable = [project.id, projectName(project), project.worktree].join("\n").toLocaleLowerCase()
    return searchable.includes(term)
  })
}

export function launcherState(input: {
  ready: boolean
  healthy: boolean | undefined
  error?: unknown
  projectCount: number
}): LauncherState {
  if (input.projectCount > 0) return "recent"
  if (input.error || input.healthy === false) return "error"
  if (!input.ready) return "loading"
  return "empty"
}
