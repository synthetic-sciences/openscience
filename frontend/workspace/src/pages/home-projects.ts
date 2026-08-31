export type ProjectRecord = {
  id: string
  worktree: string
  name?: string
  origin?: "openscience"
  time: {
    created: number
    updated?: number
    activity?: number
    archived?: number
  }
}

export type PreparedProject = ProjectRecord & {
  updatedAt: number
  pinned: boolean
}

export type LauncherState = "loading" | "error" | "empty" | "recent"

// Older servers used `updated` for runtime initialization and icon changes.
// Never present that metadata timestamp as research activity.
const timestamp = (project: ProjectRecord) => Math.max(project.time.activity ?? 0, project.time.created ?? 0)
const metadata = (project: ProjectRecord) => project.time.updated ?? project.time.created ?? 0

function uniqueProjects(projects: ProjectRecord[]) {
  const indexed = new Map<string, ProjectRecord>()
  for (const project of projects) {
    if (!project.id || !project.worktree) continue
    const current = indexed.get(project.id)
    if (!current) {
      indexed.set(project.id, project)
      continue
    }
    const latest = metadata(current) > metadata(project) ? current : project
    const activity =
      current.time.activity !== undefined || project.time.activity !== undefined
        ? Math.max(current.time.activity ?? 0, project.time.activity ?? 0)
        : undefined
    indexed.set(project.id, { ...latest, time: { ...latest.time, ...(activity === undefined ? {} : { activity }) } })
  }
  return [...indexed.values()]
}

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
  return uniqueProjects(projects)
    .filter(
      (project) =>
        project.origin === "openscience" &&
        !project.time.archived &&
        !hidden.has(project.id) &&
        !hidden.has(project.worktree),
    )
    .map(
      (project): PreparedProject => ({
        ...project,
        updatedAt: timestamp(project),
        pinned: favorites.has(project.id) || favorites.has(project.worktree),
      }),
    )
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.updatedAt - left.updatedAt ||
        projectName(left).localeCompare(projectName(right)) ||
        left.id.localeCompare(right.id),
    )
}

export function prepareArchivedProjects(projects: ProjectRecord[]) {
  return uniqueProjects(projects)
    .filter((project) => project.origin === "openscience" && Boolean(project.time.archived))
    .map(
      (project): PreparedProject => ({
        ...project,
        updatedAt: project.time.archived ?? timestamp(project),
        pinned: false,
      }),
    )
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        projectName(left).localeCompare(projectName(right)) ||
        left.id.localeCompare(right.id),
    )
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
