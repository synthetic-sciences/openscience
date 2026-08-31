import type { Project } from "@synsci/sdk/v2/client"

/** Unlike port-independent sidebar history, cached rows belong to one exact
 * server URL. Do not migrate the former unscoped cache into this authority. */
export function projectCatalogCacheKey(serverURL: string) {
  return `globalSync.project:${serverURL}`
}

/** Metadata and activity have independent clocks. A delayed icon/discovery
 * event must not undo a newer title, archive state, or research activity. */
export function mergeProjectUpdate(current: Project, incoming: Project): Project {
  const next = current.time.updated > incoming.time.updated ? current : incoming
  const activity = Math.max(current.time.activity ?? 0, incoming.time.activity ?? 0)
  if (!activity) return next
  return { ...next, time: { ...next.time, activity } }
}

/** Only the server's project library can admit a new Home row. Runtime events
 * also describe incidental directories, including incorrectly promoted legacy
 * children, so even an openscience origin is not proof of membership. */
export function createProjectCatalogSync(input: {
  load: () => Promise<Project[]>
  read: () => readonly Project[]
  write: (projects: Project[]) => void
  isCurrent: () => boolean
}) {
  let members = new Map<string, string>()
  let pending = false
  let disposed = false
  let request: Promise<void> | undefined
  const active = () => !disposed && input.isCurrent()

  function refresh(): Promise<void> {
    if (!active()) return Promise.resolve()
    pending = true
    if (request) return request
    request = Promise.resolve()
      .then(async () => {
        while (pending && active()) {
          pending = false
          const projects = await input.load()
          if (!active()) return
          const current = new Map(input.read().map((project) => [project.id, project]))
          const next = projects.map((project) => {
            const previous = current.get(project.id)
            return previous && members.get(project.id) === project.worktree
              ? mergeProjectUpdate(previous, project)
              : project
          })
          members = new Map(projects.map((project) => [project.id, project.worktree]))
          input.write(next.toSorted((a, b) => a.id.localeCompare(b.id)))
        }
      })
      .finally(() => {
        request = undefined
      })
    return request
  }

  return {
    refresh,
    update(project: Project) {
      if (!active()) return
      if (members.get(project.id) !== project.worktree) {
        if (project.origin === "openscience") return refresh()
        return
      }
      input.write(
        input.read().map((current) => (current.id === project.id ? mergeProjectUpdate(current, project) : current)),
      )
    },
    dispose() {
      disposed = true
      pending = false
    },
  }
}
