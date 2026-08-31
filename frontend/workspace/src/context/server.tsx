import { createOpenScienceClient, type Project } from "@synsci/sdk/v2/client"
import { createSimpleContext } from "@synsci/ui/context"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

type StoredProject = { projectID: string; expanded: boolean }
type LegacyProject = { worktree: string; expanded: boolean }
type VisibleProject = StoredProject & { worktree: string }

type ProjectState = {
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
}

type LegacyState = {
  projects: Record<string, LegacyProject[]>
  lastProject: Record<string, string | undefined>
}

type ProjectMigration = {
  state: ProjectState
  legacy: LegacyState
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("prj_")
}

function entries(value: unknown) {
  if (!record(value)) return []
  return Object.entries(value)
}

/**
 * Strip path-keyed project state before persistence is initialized. Legacy
 * paths stay in memory only until the server's project catalog can translate
 * them to opaque IDs.
 */
export function migrateServerProjects(value: unknown): ProjectMigration {
  const source = record(value) ? value : {}
  const current: ProjectState = { projects: {}, lastProject: {} }
  const legacy: LegacyState = { projects: {}, lastProject: {} }

  for (const [key, value] of entries(source.projects)) {
    if (!Array.isArray(value)) continue

    const projects: StoredProject[] = []
    const paths: LegacyProject[] = []

    for (const item of value) {
      if (!record(item)) continue
      const expanded = item.expanded === true
      if (opaque(item.projectID)) {
        if (!projects.some((project) => project.projectID === item.projectID)) {
          projects.push({ projectID: item.projectID, expanded })
        }
        continue
      }
      if (typeof item.worktree !== "string" || !item.worktree) continue
      if (!paths.some((project) => project.worktree === item.worktree)) {
        paths.push({ worktree: item.worktree, expanded })
      }
    }

    if (projects.length) current.projects[key] = projects
    if (paths.length) legacy.projects[key] = paths
  }

  for (const [key, value] of entries(source.lastProject)) {
    if (opaque(value)) {
      current.lastProject[key] = value
      continue
    }
    if (typeof value === "string" && value) legacy.lastProject[key] = value
  }

  return { state: current, legacy }
}

function match(projects: Project[], selector: string) {
  return projects.find(
    (project) =>
      project.id === selector || project.worktree === selector || (project.sandboxes ?? []).includes(selector),
  )
}

export function resolveServerProjects(origin: string, state: ProjectState, legacy: LegacyState, catalog: Project[]) {
  const stored = state.projects[origin] ?? []
  const paths = legacy.projects[origin] ?? []
  const resolved = paths.flatMap((item) => {
    const project = match(catalog, item.worktree)
    if (!project) return []
    return [{ projectID: project.id, expanded: item.expanded }]
  })
  const projects = [...stored, ...resolved].reduce<StoredProject[]>((result, item) => {
    const index = result.findIndex((project) => project.projectID === item.projectID)
    if (index === -1) return [...result, item]
    if (!item.expanded || result[index]?.expanded) return result
    return result.map((project, offset) => (offset === index ? { ...project, expanded: true } : project))
  }, [])
  const unresolved = paths.filter((item) => !match(catalog, item.worktree))
  const last = legacy.lastProject[origin]
  const project = last ? match(catalog, last) : undefined

  return {
    projects,
    unresolved,
    lastProject: project?.id ?? state.lastProject[origin],
    legacyLastProject: project ? undefined : last,
  }
}

export function visibleServerProjects(projects: StoredProject[], legacy: LegacyProject[], catalog: Project[]) {
  const resolved = projects.flatMap((item): VisibleProject[] => {
    const project = match(catalog, item.projectID)
    if (!project) return []
    return [{ ...item, worktree: project.worktree }]
  })
  // A legacy path is only a hint until this server confirms its ownership.
  // Keep unresolved paths in migration state, never render/bootstrap them as projects.
  const pending = legacy.flatMap((item): VisibleProject[] => {
    const project = match(catalog, item.worktree)
    return project ? [{ projectID: project.id, worktree: project.worktree, expanded: item.expanded }] : []
  })

  return [...resolved, ...pending].reduce<VisibleProject[]>((result, item) => {
    const project = item.projectID ? match(catalog, item.projectID) : match(catalog, item.worktree)
    const id = project?.id ?? item.projectID
    const worktree = project?.worktree ?? item.worktree
    if (result.some((entry) => (id ? entry.projectID === id : entry.worktree === worktree))) return result
    return [...result, { ...item, projectID: id, worktree }]
  }, [])
}

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `http://${trimmed}`
  return trimSlashes(withProtocol)
}

export function serverDisplayName(url: string) {
  if (!url) return ""
  return trimSlashes(withoutProtocol(url))
}

export const SERVER_FAILURE_THRESHOLD = 3

export function nextServerHealth(healthy: boolean | undefined, failures: number, succeeded: boolean) {
  if (succeeded) return { healthy: true, failures: 0 }
  const count = Math.min(failures + 1, SERVER_FAILURE_THRESHOLD)
  return {
    healthy: count >= SERVER_FAILURE_THRESHOLD ? false : healthy,
    failures: count,
  }
}

function withoutProtocol(value: string) {
  if (value.startsWith("http://")) return value.slice("http://".length)
  if (value.startsWith("https://")) return value.slice("https://".length)
  return value
}

function trimSlashes(value: string) {
  const parts = value.split("/")
  const offset = parts
    .slice()
    .reverse()
    .findIndex((part) => part.length > 0)
  if (offset === -1) return ""
  return parts.slice(0, parts.length - offset).join("/")
}

function projectsKey(url: string) {
  if (!url) return ""
  const host = withoutProtocol(url).split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
  return url
}

/** Live catalogs are server authorities, unlike the port-independent local UI history. */
export function serverCatalogKey(url: string) {
  return normalizeServerUrl(url) ?? ""
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultUrl: string }) => {
    const platform = usePlatform()
    const [legacy, setLegacy] = createStore<LegacyState>({
      projects: {},
      lastProject: {},
    })

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate(value) {
          const result = migrateServerProjects(value)
          setLegacy("projects", result.legacy.projects)
          setLegacy("lastProject", result.legacy.lastProject)
          return {
            ...(record(value) ? value : {}),
            projects: result.state.projects,
            lastProject: result.state.lastProject,
          }
        },
      },
      createStore({
        list: [] as string[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const [state, setState] = createStore({
      active: "",
      healthy: undefined as boolean | undefined,
      checking: false,
      failures: 0,
      projects: {} as Record<string, Project[]>,
    })
    const loading = new Map<string, Promise<Project[]>>()
    const loaded = new Map<string, number>()

    const healthy = () => state.healthy
    const checking = () => state.checking
    const failures = () => state.failures

    function setActive(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return
      setState("active", url)
    }

    function add(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return

      const fallback = normalizeServerUrl(props.defaultUrl)
      if (fallback && url === fallback) {
        setState("active", url)
        return
      }

      batch(() => {
        if (!store.list.includes(url)) {
          setStore("list", store.list.length, url)
        }
        setState("active", url)
      })
    }

    function remove(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return

      const list = store.list.filter((x) => x !== url)
      const next = state.active === url ? (list[0] ?? normalizeServerUrl(props.defaultUrl) ?? "") : state.active

      batch(() => {
        setStore("list", list)
        setState("active", next)
      })
    }

    createEffect(() => {
      if (!ready()) return
      if (state.active) return
      const url = normalizeServerUrl(props.defaultUrl)
      if (!url) return
      setState("active", url)
    })

    const isReady = createMemo(() => ready() && !!state.active)

    const check = (url: string) => {
      const signal = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(3000)
      const sdk = createOpenScienceClient({
        baseUrl: url,
        fetch: platform.fetch,
        signal,
      })
      return sdk.global
        .health()
        .then((x) => x.data?.healthy === true)
        .catch(() => false)
    }

    const loadProjects = (url: string, force = false) => {
      const key = serverCatalogKey(url)
      if (!key) return Promise.resolve([] as Project[])
      const cached = state.projects[key]
      if (cached && !force && Date.now() - (loaded.get(key) ?? 0) < 30_000) return Promise.resolve(cached)
      const active = loading.get(key)
      if (active) return active

      const sdk = createOpenScienceClient({
        baseUrl: url,
        fetch: platform.fetch,
      })
      const request = sdk.project
        .list()
        .then((result) => {
          if (result.error) throw result.error
          return (result.data ?? []).filter((project) => opaque(project.id))
        })
        .then((projects) => {
          setState("projects", key, projects)
          loaded.set(key, Date.now())
          return projects
        })
        .finally(() => loading.delete(key))
      loading.set(key, request)
      return request
    }

    const refresh = async (target = state.active) => {
      if (!target) return false
      setState("checking", true)
      const next = await check(target)
      if (state.active !== target) return next
      const result = nextServerHealth(state.healthy, state.failures, next)
      batch(() => {
        setState("healthy", result.healthy)
        setState("checking", false)
        setState("failures", result.failures)
      })
      if (next) void loadProjects(target).catch(() => undefined)
      return next
    }

    createEffect(() => {
      const url = state.active
      if (!url) return

      batch(() => {
        setState("healthy", undefined)
        setState("checking", false)
        setState("failures", 0)
      })

      let alive = true
      let busy = false
      let interval: ReturnType<typeof setInterval> | undefined

      const hidden = () => typeof document !== "undefined" && document.hidden

      const run = () => {
        // Skip probes while the tab is backgrounded — no point spending network
        // on a health check nobody can see; we refresh immediately on refocus.
        if (busy || hidden()) return
        busy = true
        void refresh(url)
          .then(() => {
            if (!alive) return
          })
          .finally(() => {
            busy = false
          })
      }

      const start = () => {
        if (!interval) interval = setInterval(run, 10_000)
      }
      const stop = () => {
        if (interval) {
          clearInterval(interval)
          interval = undefined
        }
      }
      // Pause the poll loop when hidden; on return, probe once immediately so the
      // status is fresh the moment the user looks, then resume the cadence.
      const onVisibility = () => {
        if (hidden()) stop()
        else {
          run()
          start()
        }
      }

      run()
      start()
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility)

      onCleanup(() => {
        alive = false
        stop()
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
      })
    })

    const origin = createMemo(() => projectsKey(state.active))
    const projectsList = createMemo(() =>
      visibleServerProjects(
        store.projects[origin()] ?? [],
        legacy.projects[origin()] ?? [],
        state.projects[serverCatalogKey(state.active)] ?? [],
      ),
    )
    const isLocal = createMemo(() => origin() === "local")

    createEffect(() => {
      if (!ready()) return
      const key = origin()
      if (!key) return
      const catalog = state.projects[serverCatalogKey(state.active)]
      if (!catalog) return

      const result = resolveServerProjects(key, store, legacy, catalog)
      const current = store.projects[key] ?? []
      const same =
        current.length === result.projects.length &&
        current.every(
          (project, index) =>
            project.projectID === result.projects[index]?.projectID &&
            project.expanded === result.projects[index]?.expanded,
        )
      const pending = legacy.projects[key] ?? []
      const unchanged =
        pending.length === result.unresolved.length &&
        pending.every(
          (project, index) =>
            project.worktree === result.unresolved[index]?.worktree &&
            project.expanded === result.unresolved[index]?.expanded,
        )

      batch(() => {
        if (!same) setStore("projects", key, result.projects)
        if (!unchanged) setLegacy("projects", key, result.unresolved)
        if (result.lastProject && store.lastProject[key] !== result.lastProject) {
          setStore("lastProject", key, result.lastProject)
        }
        if (result.legacyLastProject !== legacy.lastProject[key]) {
          setLegacy("lastProject", key, result.legacyLastProject)
        }
      })
    })

    const selected = (_key: string, selector: string) =>
      match(state.projects[serverCatalogKey(state.active)] ?? [], selector)
    const pending = (key: string, selector: string) =>
      (legacy.projects[key] ?? []).findIndex((project) => project.worktree === selector)

    const update = (selector: string, expanded: boolean) => {
      const key = origin()
      if (!key) return
      const project = selected(key, selector)
      if (project) {
        const index = (store.projects[key] ?? []).findIndex((item) => item.projectID === project.id)
        if (index !== -1) setStore("projects", key, index, "expanded", expanded)
        return
      }
      const index = pending(key, selector)
      if (index !== -1) setLegacy("projects", key, index, "expanded", expanded)
    }

    return {
      ready: isReady,
      healthy,
      checking,
      failures,
      refresh,
      isLocal,
      get url() {
        return state.active
      },
      get name() {
        return serverDisplayName(state.active)
      },
      get list() {
        return store.list
      },
      setActive,
      add,
      remove,
      projects: {
        list: projectsList,
        open(selector: string) {
          const key = origin()
          if (!key) return
          const project = selected(key, selector)
          if (!project) {
            const current = legacy.projects[key] ?? []
            if (current.some((item) => item.worktree === selector)) {
              void loadProjects(state.active, true).catch(() => undefined)
              return
            }
            setLegacy("projects", key, [...current, { worktree: selector, expanded: true }])
            void loadProjects(state.active, true).catch(() => undefined)
            return
          }

          const current = store.projects[key] ?? []
          if (current.some((item) => item.projectID === project.id)) return
          const unresolved = (legacy.projects[key] ?? []).filter(
            (item) => match(state.projects[serverCatalogKey(state.active)] ?? [], item.worktree)?.id !== project.id,
          )
          batch(() => {
            setStore("projects", key, [{ projectID: project.id, expanded: true }, ...current])
            setLegacy("projects", key, unresolved)
          })
        },
        close(selector: string) {
          const key = origin()
          if (!key) return
          const project = selected(key, selector)
          const projectID = project?.id ?? (opaque(selector) ? selector : undefined)
          const current = store.projects[key] ?? []
          const unresolved = (legacy.projects[key] ?? []).filter((item) => item.worktree !== selector)
          batch(() => {
            if (projectID) {
              setStore(
                "projects",
                key,
                current.filter((item) => item.projectID !== projectID),
              )
            }
            if (unresolved.length !== (legacy.projects[key] ?? []).length) {
              setLegacy("projects", key, unresolved)
            }
          })
        },
        expand(selector: string) {
          update(selector, true)
        },
        collapse(selector: string) {
          update(selector, false)
        },
        move(selector: string, toIndex: number) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const project = selected(key, selector)
          const fromIndex = current.findIndex((item) => item.projectID === (project?.id ?? selector))
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return store.lastProject[key] ?? legacy.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          const project = selected(key, directory)
          const projectID = project?.id ?? (opaque(directory) ? directory : undefined)
          if (projectID) {
            batch(() => {
              setStore("lastProject", key, projectID)
              setLegacy("lastProject", key, undefined)
            })
            return
          }
          setLegacy("lastProject", key, directory)
        },
      },
    }
  },
})
