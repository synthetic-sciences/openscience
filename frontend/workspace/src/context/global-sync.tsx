import {
  type Message,
  type Agent,
  type Session,
  type Part,
  type Config,
  type Path,
  type Project,
  type FileDiff,
  type Todo,
  type SessionStatus,
  type SessionRequestProgress,
  type ProviderListResponse,
  type ProviderAuthResponse,
  type Command,
  type McpStatus,
  type LspStatus,
  type VcsInfo,
  type PermissionRequest,
  type QuestionRequest,
  createOpenScienceClient,
} from "@synsci/sdk/v2/client"
import { createStore, produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { Binary } from "@synsci/util/binary"
import { retry } from "@synsci/util/retry"
import { useGlobalSDK } from "./global-sdk"
import { createInflightCache } from "./inflight-cache"
import { createProjectCatalogSync, projectCatalogCacheKey } from "./project-catalog"
import { createListeners } from "./listeners"
import {
  createReconnectGenerationGuard,
  mergeHydratedMessages,
  nextReconnectHydrationLimit,
  reconnectHydrationLimit,
} from "./session-hydration"
// The shape pages/error.tsx renders; kept local so this module does not
// import a page.
type InitError = { code: string; message?: string; cause?: unknown }

export function syncErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === "string" && error.trim()) return error
  if (!error || typeof error !== "object") return "The server returned an unexpected response."

  const value = error as Record<string, unknown>
  for (const key of ["message", "detail", "error", "data", "cause"] as const) {
    const candidate = value[key]
    if (candidate === error || candidate === undefined || candidate === null) continue
    const message = syncErrorMessage(candidate)
    if (message !== "The server returned an unexpected response.") return message
  }
  if (typeof value.status === "number") return `Request failed with status ${value.status}.`
  return "The server returned an unexpected response."
}

export function handleInstanceDisposed(clearSessionStatus: () => void, scheduleSync: () => void) {
  clearSessionStatus()
  scheduleSync()
}

/**
 * The project the user worked in most recently: substantive activity first,
 * creation time as the fallback, archived projects never. Home warms this one
 * after first paint so opening it does not pay the instance bootstrap.
 */
export function recentProject<T extends { time: { created: number; activity?: number; archived?: number } }>(
  projects: readonly T[],
) {
  return projects.reduce<T | undefined>((best, project) => {
    if (project.time.archived) return best
    if (!best) return project
    const stamp = (item: T) => item.time.activity ?? item.time.created
    return stamp(project) > stamp(best) ? project : best
  }, undefined)
}

/** Delay before Home warms the most recent project, past the launch paint. */
export const PREFETCH_DELAY_MS = 250

/** Delay after a project's essential state before its catalogs are fetched. */
export const CATALOG_DELAY_MS = 250
import {
  batch,
  createContext,
  createEffect,
  untrack,
  getOwner,
  runWithOwner,
  useContext,
  onCleanup,
  onMount,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { showToast } from "@synsci/ui/toast"
import { getFilename } from "@synsci/util/path"
import { usePlatform } from "./platform"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { projectScope } from "@/utils/project-route"
import { checksum } from "@synsci/util/encode"

type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export interface Skill {
  name: string
  description: string
  location: string
  origin: "default" | "installed" | "user" | "project"
  category?: string
  tags?: string[]
  entry?: boolean
  permission_action?: "allow" | "ask" | "deny"
  recommended?: boolean
  enabled?: boolean
  disabled_by?: "server" | "project"
  catalog_status?: string
}

type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  skill: Skill[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_progress: {
    [sessionID: string]: SessionRequestProgress
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp: {
    [name: string]: McpStatus
  }
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

type ChildOptions = {
  bootstrap?: boolean
  projectID?: string
}

function normalizeProviderList(input: ProviderListResponse): ProviderListResponse {
  return {
    ...input,
    all: input.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated")),
    })),
  }
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")
  const vcsCache = new Map<string, VcsCache>()
  const metaCache = new Map<string, MetaCache>()
  const iconCache = new Map<string, IconCache>()

  const sdkCache = new Map<string, ReturnType<typeof createOpenScienceClient>>()
  const projectFor = (directory: string, projectID?: string) => {
    if (projectID) return projectID
    return globalStore.project.find(
      (project) => project.worktree === directory || (project.sandboxes ?? []).includes(directory),
    )?.id
  }
  const scopeFor = (directory: string, projectID?: string) =>
    `${projectFor(directory, projectID) ?? directory}\n${directory}`
  const persistenceFor = (directory: string, projectID?: string) => {
    const scope = projectScope(globalStore.project, directory)
    if (scope !== directory) return scope
    if (projectID) return `${projectID}~${checksum(directory) ?? "worktree"}`
    return directory
  }
  const sdkFor = (directory: string, projectID?: string) => {
    const project = projectFor(directory, projectID)
    const key = scopeFor(directory, projectID)
    const cached = sdkCache.get(key)
    if (cached) return cached

    const sdk = createOpenScienceClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      directory,
      projectID: project,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  // Global and project bootstrap can ask for the same 4 MB provider catalog a
  // few milliseconds apart. Share only that bootstrap burst; expire entries
  // promptly so project config/provider changes are never held stale here, and
  // bound the wait so a request that never returns cannot pin the key and
  // silently stop every later refresh (see inflight-cache.ts).
  // scopeFor() folds the project id into the key, so the id itself is kept
  // alongside it — the loader needs the pair the caller actually asked with.
  const providerScopes = new Map<string, string | undefined>()
  const providerLoads = createInflightCache<ProviderListResponse>(async (key) => {
    const [, directory = ""] = key.split("\n")
    try {
      const scoped = await sdkFor(directory, providerScopes.get(key)).provider.list()
      return normalizeProviderList(scoped.data!)
    } catch (error) {
      // The catalog is a property of the install, not of one project, so a
      // project that has gone stale (its folder deleted — the server answers
      // 410) must not be able to empty it. Every model surface reads this
      // store, so failing here looked like "my API key vanished".
      console.warn("Provider catalog unavailable for this project; using the install catalog", { directory, error })
      const global = await globalSDK.client.provider.list()
      return normalizeProviderList(global.data!)
    }
  })
  const loadProvider = (directory: string, projectID?: string) => {
    const key = scopeFor(directory, projectID)
    providerScopes.set(key, projectID)
    return providerLoads.get(key)
  }

  const [projectCache, setProjectCache, , projectCacheReady] = persisted(
    Persist.global(projectCatalogCacheKey(globalSDK.url)),
    createStore({ value: [] as Project[] }),
  )

  const sanitizeProject = (project: Project) => {
    if (!project.icon?.url && !project.icon?.override) return project
    return {
      ...project,
      icon: {
        ...project.icon,
        url: undefined,
        override: undefined,
      },
    }
  }
  const [globalStore, setGlobalStore] = createStore<{
    ready: boolean
    error?: InitError
    path: Path
    project: Project[]
    provider: ProviderListResponse
    provider_auth: ProviderAuthResponse
    config: Config
    reload: undefined | "pending" | "complete"
  }>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: projectCache.value,
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
    config: {},
    reload: undefined,
  })

  const serverURL = globalSDK.url
  const [catalogState, setCatalogState] = createStore({ loaded: false })
  const projectCatalog = createProjectCatalogSync({
    load: async () => {
      const response = await globalSDK.client.project.list()
      if (response.error) throw response.error
      return (response.data ?? [])
        .filter((project) => !!project?.id)
        .filter((project) => !!project.worktree && !project.worktree.includes("openscience-test"))
    },
    read: () => globalStore.project,
    write: (projects) =>
      batch(() => {
        setCatalogState("loaded", true)
        setGlobalStore("project", reconcile(projects, { key: "id" }))
      }),
    isCurrent: () => globalSDK.url === serverURL,
  })
  onCleanup(() => projectCatalog.dispose())

  const rememberProject = (project: Project) => {
    void projectCatalog
      .update(project)
      ?.catch((error) => console.warn("Failed to refresh the project library", { error }))
    return project
  }

  const queued = new Set<string>()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const item of queued) {
      queued.delete(item)
      items.push(item)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (!directory) return
    queued.add(directory)
    if (paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (paused()) return
    schedule()
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (true) {
        if (paused()) return

        if (root) {
          root = false
          await bootstrap()
          await tick()
          continue
        }

        const dirs = take(2)
        if (dirs.length === 0) return

        await Promise.all(dirs.map((dir) => bootstrapInstance(dir)))
        await tick()
      }
    } finally {
      running = false
      if (paused()) return
      if (root || queued.size) schedule()
    }
  }

  createEffect(() => {
    if (!projectCacheReady()) return
    if (catalogState.loaded) return
    if (globalStore.project.length !== 0) return
    const cached = projectCache.value
    if (cached.length === 0) return
    setGlobalStore("project", cached)
  })

  createEffect(() => {
    if (!projectCacheReady()) return
    const projects = globalStore.project
    if (projects.length === 0 && !catalogState.loaded) {
      const cachedLength = untrack(() => projectCache.value.length)
      if (cachedLength !== 0) return
    }
    setProjectCache("value", projects.map(sanitizeProject))
  })

  createEffect(() => {
    if (globalStore.reload !== "complete") return
    setGlobalStore("reload", undefined)
    refresh()
  })

  const children: Record<string, [Store<State>, SetStoreFunction<State>]> = {}
  type TranscriptMutation = { revision: number; removed: boolean }
  type TranscriptMutations = {
    revision: number
    messages: Map<string, TranscriptMutation>
    parts: Map<string, TranscriptMutation>
  }
  const transcriptMutations = new Map<string, TranscriptMutations>()
  const reconnectGenerations = createReconnectGenerationGuard()
  const transcriptKey = (directory: string, sessionID: string) => `${directory}\0${sessionID}`
  const transcriptState = (directory: string, sessionID: string) => {
    const key = transcriptKey(directory, sessionID)
    const existing = transcriptMutations.get(key)
    if (existing) return existing
    const created = { revision: 0, messages: new Map(), parts: new Map() } satisfies TranscriptMutations
    transcriptMutations.set(key, created)
    return created
  }
  const markTranscriptMutation = (
    directory: string,
    sessionID: string,
    kind: "messages" | "parts",
    id: string,
    removed = false,
  ) => {
    const state = transcriptState(directory, sessionID)
    state.revision += 1
    state[kind].set(id, { revision: state.revision, removed })
  }
  const transcriptChangesSince = (mutations: Map<string, TranscriptMutation>, revision: number) => {
    const changed = new Set<string>()
    const removed = new Set<string>()
    for (const [id, mutation] of mutations) {
      if (mutation.revision <= revision) continue
      if (mutation.removed) removed.add(id)
      else changed.add(id)
    }
    return { changed, removed }
  }

  /** Notify settings surfaces after any local provider credential changes. */
  const providerRefresh = createListeners()
  /** Notify account surfaces once the server stored a newer Ace account summary. */
  const accountRefresh = createListeners()

  /**
   * Re-read the provider catalog into every store that shows it. Bootstrap
   * alone is not enough: adding a key or finishing an OAuth sign-in changes the
   * catalog while the page is already running, and the settings panel, the
   * model picker and the composer all read it from here. Errors surface — a
   * silent failure here looks exactly like "the key was never saved".
   */
  async function refreshProviders() {
    providerLoads.invalidate()
    const reload = async (
      directory: string,
      projectID: string | undefined,
      apply: (value: ProviderListResponse) => void,
    ) => {
      if (!directory) return
      apply(await loadProvider(directory, projectID))
    }
    await providerRefresh.notifyAfter(async () => {
      await Promise.all([
        reload(globalStore.path.worktree || globalStore.path.directory, undefined, (value) =>
          setGlobalStore("provider", reconcile(value)),
        ),
        // Only projects whose runtime was asked for. Every Home card owns a
        // child store, and a catalog read against a card's directory mints
        // a server instance for it; on launch that was one instance per
        // known project the moment managed pricing arrived.
        ...Object.entries(children)
          .filter(([directory]) => requested.has(directory))
          .map(([directory, [store, setStore]]) =>
            reload(directory, store.project || undefined, (value) => setStore("provider", reconcile(value))),
          ),
      ])
    })
  }

  const booting = new Map<string, Promise<void>>()
  // Scopes being warmed for a project nobody opened. A failure there is
  // logged, never shown: the launch screen must not toast about a folder the
  // user did not ask for, and the project stays untouched for an explicit open.
  const warming = new Set<string>()
  // Directories whose runtime was actually bootstrapped. Child stores also
  // exist for Home cards, sidebar entries and notification lookups; those never
  // issue a project-scoped request and must stay metadata-only.
  const requested = new Set<string>()
  // Directories the user explicitly opened. A warmed project has its runtime
  // but not its catalogs: listing commands and MCP status launches every
  // configured MCP server, and the skill catalog scans each skill root, so
  // those wait for the first open.
  const opened = new Set<string>()
  // Directories whose catalogs the current bootstrap already fetched, so an
  // open landing while the non-blocking requests are in flight fetches once.
  const catalogued = new Set<string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const defer = (fn: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, delay)
    timers.add(timer)
  }
  onCleanup(() => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  })

  // One report per page load closes the server's startup timing line
  // (listening, first instance, interactive) in the sidecar log.
  const startup = { reported: false, warmed: false }
  function interactive(phase: "home" | "project") {
    if (startup.reported) return
    startup.reported = true
    void globalSDK.client.app
      .log({
        service: "startup",
        level: "info",
        message: "interactive",
        extra: { phase, page: Math.round(performance.now()) },
      })
      .catch(() => {})
  }

  // The Home route bootstraps nothing. Warm the project the user last worked
  // in once the launch screen has painted so opening it does not wait on the
  // server instance; a project route already owns its own bootstrap. Once per
  // page load: a reconnect re-pushes whatever was opened, and a warmup that
  // failed must not be retried on every reconnect.
  function prefetch() {
    if (startup.warmed) return
    startup.warmed = true
    if (requested.size !== 0) return
    const project = recentProject(globalStore.project)
    if (!project) return
    void bootstrapInstance(project.worktree, project.id, "warm")
  }
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sessionRecentWindow = 4 * 60 * 60 * 1000
  const sessionRecentLimit = 50

  function sessionUpdatedAt(session: Session) {
    return session.time.updated ?? session.time.created
  }

  function compareSessionRecent(a: Session, b: Session) {
    const aUpdated = sessionUpdatedAt(a)
    const bUpdated = sessionUpdatedAt(b)
    if (aUpdated !== bUpdated) return bUpdated - aUpdated
    return a.id.localeCompare(b.id)
  }

  function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
    if (limit <= 0) return [] as Session[]
    const selected: Session[] = []
    const seen = new Set<string>()
    for (const session of sessions) {
      if (!session?.id) continue
      if (seen.has(session.id)) continue
      seen.add(session.id)

      if (sessionUpdatedAt(session) <= cutoff) continue

      const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
      if (index === -1) selected.push(session)
      if (index !== -1) selected.splice(index, 0, session)
      if (selected.length > limit) selected.pop()
    }
    return selected
  }

  function trimSessions(input: Session[], options: { limit: number; permission: Record<string, PermissionRequest[]> }) {
    const limit = Math.max(0, options.limit)
    const cutoff = Date.now() - sessionRecentWindow
    const all = input
      .filter((s) => !!s?.id)
      .filter((s) => !s.time?.archived)
      .sort((a, b) => a.id.localeCompare(b.id))

    const roots = all.filter((s) => !s.parentID)
    const children = all.filter((s) => !!s.parentID)

    const base = roots.slice(0, limit)
    const recent = takeRecentSessions(roots.slice(limit), sessionRecentLimit, cutoff)
    const keepRoots = [...base, ...recent]

    const keepRootIds = new Set(keepRoots.map((s) => s.id))
    const keepChildren = children.filter((s) => {
      if (s.parentID && keepRootIds.has(s.parentID)) return true
      const perms = options.permission[s.id] ?? []
      if (perms.length > 0) return true
      return sessionUpdatedAt(s) > cutoff
    })

    return [...keepRoots, ...keepChildren].sort((a, b) => a.id.localeCompare(b.id))
  }

  function ensureChild(directory: string, projectID?: string) {
    if (!directory) console.error("No directory provided")
    if (!children[directory]) {
      const scope = persistenceFor(directory, projectID)
      const vcs = runWithOwner(owner, () =>
        persisted(
          Persist.workspace(scope, "vcs", ["vcs.v1"]),
          createStore({ value: undefined as VcsInfo | undefined }),
        ),
      )
      if (!vcs) throw new Error("Failed to create persisted cache")
      const vcsStore = vcs[0]
      const vcsReady = vcs[3]
      vcsCache.set(directory, { store: vcsStore, setStore: vcs[1], ready: vcsReady })

      const meta = runWithOwner(owner, () =>
        persisted(
          Persist.workspace(scope, "project", ["project.v1"]),
          createStore({ value: undefined as ProjectMeta | undefined }),
        ),
      )
      if (!meta) throw new Error("Failed to create persisted project metadata")
      metaCache.set(directory, { store: meta[0], setStore: meta[1], ready: meta[3] })

      const icon = runWithOwner(owner, () =>
        persisted(
          Persist.workspace(scope, "icon", ["icon.v1"]),
          createStore({ value: undefined as string | undefined }),
        ),
      )
      if (!icon) throw new Error("Failed to create persisted project icon")
      iconCache.set(directory, { store: icon[0], setStore: icon[1], ready: icon[3] })

      const init = () => {
        const child = createStore<State>({
          project: "",
          projectMeta: meta[0].value,
          icon: icon[0].value,
          provider: { all: [], connected: [], default: {} },
          config: {},
          path: { state: "", config: "", worktree: "", directory: "", home: "" },
          status: "loading" as const,
          agent: [],
          command: [],
          skill: [],
          session: [],
          sessionTotal: 0,
          session_status: {},
          session_progress: {},
          session_diff: {},
          todo: {},
          permission: {},
          question: {},
          mcp: {},
          lsp: [],
          vcs: vcsStore.value,
          limit: 5,
          message: {},
          part: {},
        })

        children[directory] = child

        createEffect(() => {
          if (!vcsReady()) return
          const cached = vcsStore.value
          if (!cached?.branch) return
          child[1]("vcs", (value) => value ?? cached)
        })

        createEffect(() => {
          child[1]("projectMeta", meta[0].value)
        })

        createEffect(() => {
          child[1]("icon", icon[0].value)
        })
      }

      runWithOwner(owner, init)
    }
    const childStore = children[directory]
    if (!childStore) throw new Error("Failed to create store")
    return childStore
  }

  function child(directory: string, options: ChildOptions = {}) {
    const childStore = ensureChild(directory, options.projectID)
    if (!(options.bootstrap ?? true)) return childStore
    const first = !opened.has(directory)
    opened.add(directory)
    if (childStore[0].status === "loading") {
      void bootstrapInstance(directory, options.projectID)
      return childStore
    }
    // Bootstrapped before anyone opened it, by the Home warmup: the runtime
    // is live and only the catalogs were left for this moment.
    if (first) void loadCatalogs(directory, options.projectID)
    return childStore
  }

  async function loadSessions(directory: string, projectID?: string) {
    const key = scopeFor(directory, projectID)
    const pending = sessionLoads.get(key)
    if (pending) return pending

    const [store, setStore] = child(directory, { bootstrap: false, projectID })
    const meta = sessionMeta.get(key)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, { limit: store.limit, permission: store.permission })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      return
    }

    const promise = sdkFor(directory, projectID)
      .session.list()
      .then((x) => {
        const nonArchived = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .sort((a, b) => a.id.localeCompare(b.id))

        // Read the current limit at resolve-time so callers that bump the limit while
        // a request is in-flight still get the expanded result.
        const limit = store.limit

        const children = store.session.filter((s) => !!s.parentID)
        const sessions = trimSessions([...nonArchived, ...children], { limit, permission: store.permission })

        // Store total session count (used for "load more" pagination)
        setStore("sessionTotal", nonArchived.length)
        setStore("session", reconcile(sessions, { key: "id" }))
        sessionMeta.set(key, { limit })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        // Aborted/cancelled loads happen routinely when the user switches
        // projects quickly; don't flash an error toast for those.
        const name = err?.name ?? ""
        if (name === "AbortError" || name === "TimeoutError" || /\babort|cancell?ed/i.test(String(err?.message ?? "")))
          return
        const project = getFilename(directory)
        showToast({
          title: language.t("toast.session.listFailed.title", { project }),
          description: syncErrorMessage(err),
        })
      })

    sessionLoads.set(key, promise)
    promise.finally(() => {
      sessionLoads.delete(key)
    })
    return promise
  }

  // Catalogs the first paint does not show; they load once the session list
  // is on screen, and only for a project somebody opened.
  function loadCatalogs(directory: string, projectID?: string) {
    if (catalogued.has(directory)) return Promise.resolve()
    catalogued.add(directory)
    const [, setStore] = ensureChild(directory, projectID)
    const sdk = sdkFor(directory, projectID)
    return Promise.all([
      sdk.command.list().then((x) => setStore("command", x.data ?? [])),
      sdk.app
        .skills()
        .then((x) => setStore("skill", x.data ?? []))
        .catch(() => {}),
      sdk.mcp.status().then((x) => setStore("mcp", x.data!)),
      sdk.lsp.status().then((x) => setStore("lsp", x.data!)),
    ]).catch((error) => console.warn("Failed to load project catalogs", { directory, error }))
  }

  async function bootstrapInstance(directory: string, projectID?: string, mode: "open" | "warm" = "open") {
    if (!directory) return
    requested.add(directory)
    const key = scopeFor(directory, projectID)
    const pending = booting.get(key)
    if (pending) {
      // An explicit open joining a warmup owns its failure from here on.
      if (mode === "open") warming.delete(key)
      return pending
    }
    if (mode === "warm") warming.add(key)
    // A fresh bootstrap, first or re-pushed, fetches the catalogs again.
    catalogued.delete(directory)

    const promise = (async () => {
      const [store, setStore] = ensureChild(directory, projectID)
      const cache = vcsCache.get(directory)
      if (!cache) return
      const meta = metaCache.get(directory)
      if (!meta) return
      const sdk = sdkFor(directory, projectID)

      setStore("status", "loading")

      // projectMeta is synced from persisted storage in ensureChild.
      // vcs is seeded from persisted storage in ensureChild.

      const blockingRequests = {
        project: () => sdk.project.current().then((x) => setStore("project", x.data!.id)),
        provider: () => loadProvider(directory, projectID).then((value) => setStore("provider", reconcile(value))),
        agent: () => sdk.app.agents().then((x) => setStore("agent", x.data ?? [])),
        config: () => sdk.config.get().then((x) => setStore("config", x.data!)),
      }

      try {
        await Promise.all(Object.values(blockingRequests).map((p) => retry(p)))
      } catch (err) {
        if (warming.has(key)) {
          console.warn("Failed to warm project", { directory, error: err })
          // Back to untouched: an explicit open bootstraps again, and the
          // reconnect and catalog fan-outs skip this directory until it does.
          setStore("status", "loading")
          requested.delete(directory)
          return
        }
        console.error("Failed to bootstrap instance", err)
        const project = getFilename(directory)
        const message = syncErrorMessage(err)
        showToast({ title: `Failed to reload ${project}`, description: message })
        setStore("status", "partial")
        return
      }

      if (store.status !== "complete") setStore("status", "partial")
      interactive("project")

      Promise.all([
        sdk.path.get().then((x) => setStore("path", x.data!)),
        sdk.session.status().then((x) => setStore("session_status", x.data!)),
        loadSessions(directory, projectID),
        sdk.vcs.get().then((x) => {
          const next = x.data ?? store.vcs
          setStore("vcs", next)
          if (next?.branch) cache.setStore("value", next)
        }),
        sdk.permission.list().then((x) => {
          const grouped: Record<string, PermissionRequest[]> = {}
          for (const perm of x.data ?? []) {
            if (!perm?.id || !perm.sessionID) continue
            const existing = grouped[perm.sessionID]
            if (existing) {
              existing.push(perm)
              continue
            }
            grouped[perm.sessionID] = [perm]
          }

          batch(() => {
            for (const sessionID of Object.keys(store.permission)) {
              if (grouped[sessionID]) continue
              setStore("permission", sessionID, [])
            }
            for (const [sessionID, permissions] of Object.entries(grouped)) {
              setStore(
                "permission",
                sessionID,
                reconcile(
                  permissions.filter((p) => !!p?.id).sort((a, b) => a.id.localeCompare(b.id)),
                  { key: "id" },
                ),
              )
            }
          })
        }),
        sdk.question.list().then((x) => {
          const grouped: Record<string, QuestionRequest[]> = {}
          for (const question of x.data ?? []) {
            if (!question?.id || !question.sessionID) continue
            const existing = grouped[question.sessionID]
            if (existing) {
              existing.push(question)
              continue
            }
            grouped[question.sessionID] = [question]
          }

          batch(() => {
            for (const sessionID of Object.keys(store.question)) {
              if (grouped[sessionID]) continue
              setStore("question", sessionID, [])
            }
            for (const [sessionID, questions] of Object.entries(grouped)) {
              setStore(
                "question",
                sessionID,
                reconcile(
                  questions.filter((q) => !!q?.id).sort((a, b) => a.id.localeCompare(b.id)),
                  { key: "id" },
                ),
              )
            }
          })
        }),
      ]).then(() => {
        setStore("status", "complete")
        // A warmed project keeps its MCP servers down until its first open.
        if (opened.has(directory)) defer(() => void loadCatalogs(directory, projectID), CATALOG_DELAY_MS)
      })
    })()

    booting.set(key, promise)
    promise.finally(() => {
      booting.delete(key)
      warming.delete(key)
    })
    return promise
  }

  /**
   * The global SSE endpoint is intentionally ephemeral: reconnecting starts a
   * fresh stream and cannot replay events emitted while the browser was
   * disconnected. Rehydrate only transcripts that are already open/cached so
   * a brief transport interruption cannot leave a live turn missing text or
   * reasoning until the user reloads the page.
   */
  async function refreshLoadedMessages(directory: string) {
    const existing = children[directory]
    if (!existing) return
    const [store, setStore] = existing
    const loaded = Object.entries(store.message).filter(([, messages]) => messages.length > 0)
    if (!loaded.length) return

    const client = sdkFor(directory, store.project)
    for (let index = 0; index < loaded.length; index += 2) {
      const slice = loaded.slice(index, index + 2)
      await Promise.all(
        slice.map(async ([sessionID, current]) => {
          const reconnectKey = transcriptKey(directory, sessionID)
          const generation = reconnectGenerations.begin(reconnectKey)
          const anchors = new Set(current.map((message) => message.id))
          const startedAt = transcriptState(directory, sessionID).revision
          let limit = reconnectHydrationLimit(current.length)
          let items: Array<{ info: Message; parts: Part[] }> = []
          let completeSnapshot = false

          // The endpoint returns the newest N. Expand a full window until it
          // overlaps the history that was present when this request began; a
          // fixed amount of headroom can otherwise leave a silent gap after a
          // long disconnect.
          while (true) {
            const response = await client.session.messages({ sessionID, limit })
            if (!reconnectGenerations.isCurrent(reconnectKey, generation)) return
            items = (response.data ?? []).filter((item) => !!item?.info?.id)
            completeSnapshot = items.length < limit
            const next = nextReconnectHydrationLimit({
              limit,
              snapshotCount: items.length,
              overlapsCached: items.some((item) => anchors.has(item.info.id)),
            })
            if (next === undefined) break
            limit = next
          }

          if (!reconnectGenerations.isCurrent(reconnectKey, generation)) return

          const messages = items
            .map((item) => item.info)
            .filter((message) => !!message?.id)
            .sort((a, b) => a.id.localeCompare(b.id))

          batch(() => {
            // Read the store only after the request settles. SSE may have
            // updated it while the snapshot was in flight; those entities must
            // win over older response bytes, while untouched fetched entities
            // still refresh the cache.
            const mutations = transcriptState(directory, sessionID)
            const messageChanges = transcriptChangesSince(mutations.messages, startedAt)
            const partChanges = transcriptChangesSince(mutations.parts, startedAt)
            const liveMessages = store.message[sessionID] ?? []
            const mergedMessages = mergeHydratedMessages(liveMessages, messages, {
              preserveCached: !completeSnapshot,
              preferCached: messageChanges.changed,
              removed: messageChanges.removed,
            })
            setStore("message", sessionID, reconcile(mergedMessages, { key: "id" }))

            for (const item of items) {
              if (messageChanges.removed.has(item.info.id)) continue
              const incomingParts = item.parts.filter((part) => !!part?.id).sort((a, b) => a.id.localeCompare(b.id))
              const liveParts = store.part[item.info.id] ?? []
              const mergedParts = mergeHydratedMessages(liveParts, incomingParts, {
                // A message response contains its complete part list, unlike
                // the partial transcript window. Preserve only parts that SSE
                // changed after this request started.
                preserveCached: false,
                preferCached: partChanges.changed,
                removed: partChanges.removed,
              })
              setStore("part", item.info.id, reconcile(mergedParts, { key: "id" }))
            }
          })
        }),
      )
    }
  }

  let skillRefreshVersion = 0
  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details

    if (directory === "global") {
      switch (event?.type) {
        case "server.connected": {
          if (!globalStore.ready) return
          refresh()
          for (const directory of requested) {
            push(directory)
            void refreshLoadedMessages(directory).catch((error) =>
              console.warn("Failed to backfill loaded transcripts after reconnect", { directory, error }),
            )
          }
          return
        }
        case "global.disposed": {
          // Nobody is waiting on this one, so it has no error UI to surface
          // into — unlike the settings panels, which await their own call and
          // report the failure there.
          void refreshProviders().catch((error) => console.error("Failed to refresh providers", { error }))
          return
        }
        case "account.updated": {
          // A background refresh stored a newer account summary. Surfaces that
          // showed the previous one re-read it; nothing here is awaited.
          void accountRefresh.notifyAfter(() => Promise.resolve())
          return
        }
        case "skill.updated": {
          const version = ++skillRefreshVersion
          void globalSDK.client.global.config
            .get()
            .then((response) => {
              if (version === skillRefreshVersion && response.data) setGlobalStore("config", reconcile(response.data))
            })
            .catch(() => {})
          for (const [directory, [store, setStore]] of Object.entries(children)) {
            if (!requested.has(directory)) continue
            void sdkFor(directory, store.project || undefined)
              .app.skills()
              .then((response) => {
                if (version === skillRefreshVersion) setStore("skill", response.data ?? [])
              })
              .catch(() => {})
          }
          return
        }
        case "project.updated": {
          rememberProject(event.properties)
          break
        }
      }
      return
    }

    const existing = children[directory]
    if (!existing) return

    const [store, setStore] = existing

    const cleanupSessionCaches = (sessionID: string) => {
      if (!sessionID) return
      const key = transcriptKey(directory, sessionID)
      transcriptMutations.delete(key)
      reconnectGenerations.invalidate(key)

      const hasAny =
        store.message[sessionID] !== undefined ||
        store.session_diff[sessionID] !== undefined ||
        store.todo[sessionID] !== undefined ||
        store.permission[sessionID] !== undefined ||
        store.question[sessionID] !== undefined ||
        store.session_status[sessionID] !== undefined ||
        store.session_progress[sessionID] !== undefined

      if (!hasAny) return

      setStore(
        produce((draft) => {
          const messages = draft.message[sessionID]
          if (messages) {
            for (const message of messages) {
              const id = message?.id
              if (!id) continue
              delete draft.part[id]
            }
          }

          delete draft.message[sessionID]
          delete draft.session_diff[sessionID]
          delete draft.todo[sessionID]
          delete draft.permission[sessionID]
          delete draft.question[sessionID]
          delete draft.session_status[sessionID]
          delete draft.session_progress[sessionID]
        }),
      )
    }

    switch (event.type) {
      case "server.instance.disposed": {
        handleInstanceDisposed(
          () => {
            setStore("session_status", reconcile({}))
            setStore("session_progress", reconcile({}))
          },
          () => {
            if (requested.has(directory)) push(directory)
          },
        )
        return
      }
      case "session.created": {
        const info = event.properties.info
        const result = Binary.search(store.session, info.id, (s) => s.id)
        if (result.found) {
          setStore("session", result.index, reconcile(info))
          break
        }
        const next = store.session.slice()
        next.splice(result.index, 0, info)
        const trimmed = trimSessions(next, { limit: store.limit, permission: store.permission })
        setStore("session", reconcile(trimmed, { key: "id" }))
        if (!info.parentID) {
          setStore("sessionTotal", (value) => value + 1)
        }
        break
      }
      case "session.updated": {
        const info = event.properties.info
        const result = Binary.search(store.session, info.id, (s) => s.id)
        if (info.time.archived) {
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          cleanupSessionCaches(info.id)
          if (info.parentID) break
          setStore("sessionTotal", (value) => Math.max(0, value - 1))
          break
        }
        if (result.found) {
          setStore("session", result.index, reconcile(info))
          break
        }
        const next = store.session.slice()
        next.splice(result.index, 0, info)
        const trimmed = trimSessions(next, { limit: store.limit, permission: store.permission })
        setStore("session", reconcile(trimmed, { key: "id" }))
        break
      }
      case "session.deleted": {
        const sessionID = event.properties.info.id
        const result = Binary.search(store.session, sessionID, (s) => s.id)
        if (result.found) {
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(sessionID)
        if (event.properties.info.parentID) break
        setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      case "session.diff":
        setStore("session_diff", event.properties.sessionID, reconcile(event.properties.diff, { key: "file" }))
        break
      case "todo.updated":
        setStore("todo", event.properties.sessionID, reconcile(event.properties.todos, { key: "id" }))
        break
      case "session.status": {
        setStore("session_status", event.properties.sessionID, reconcile(event.properties.status))
        break
      }
      case "session.request.progress": {
        setStore("session_progress", event.properties.sessionID, reconcile(event.properties))
        break
      }
      case "message.updated": {
        markTranscriptMutation(directory, event.properties.info.sessionID, "messages", event.properties.info.id)
        const messages = store.message[event.properties.info.sessionID]
        if (!messages) {
          setStore("message", event.properties.info.sessionID, [event.properties.info])
          break
        }
        const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
        if (result.found) {
          setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
          break
        }
        setStore(
          "message",
          event.properties.info.sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties.info)
          }),
        )
        break
      }
      case "message.removed": {
        const sessionID = event.properties.sessionID
        const messageID = event.properties.messageID
        markTranscriptMutation(directory, sessionID, "messages", messageID, true)

        setStore(
          produce((draft) => {
            const messages = draft.message[sessionID]
            if (messages) {
              const result = Binary.search(messages, messageID, (m) => m.id)
              if (result.found) {
                messages.splice(result.index, 1)
              }
            }

            delete draft.part[messageID]
          }),
        )
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        markTranscriptMutation(directory, part.sessionID, "parts", part.id)
        const parts = store.part[part.messageID]
        if (!parts) {
          setStore("part", part.messageID, [part])
          break
        }
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          setStore("part", part.messageID, result.index, reconcile(part))
          break
        }
        setStore(
          "part",
          part.messageID,
          produce((draft) => {
            draft.splice(result.index, 0, part)
          }),
        )
        break
      }
      case "message.part.removed": {
        const messageID = event.properties.messageID
        markTranscriptMutation(directory, event.properties.sessionID, "parts", event.properties.partID, true)
        const parts = store.part[messageID]
        if (!parts) break
        const result = Binary.search(parts, event.properties.partID, (p) => p.id)
        if (result.found) {
          setStore(
            produce((draft) => {
              const list = draft.part[messageID]
              if (!list) return
              const next = Binary.search(list, event.properties.partID, (p) => p.id)
              if (!next.found) return
              list.splice(next.index, 1)
              if (list.length === 0) delete draft.part[messageID]
            }),
          )
        }
        break
      }
      case "vcs.branch.updated": {
        const next = { branch: event.properties.branch }
        setStore("vcs", next)
        const cache = vcsCache.get(directory)
        if (cache) cache.setStore("value", next)
        break
      }
      case "permission.asked": {
        const sessionID = event.properties.sessionID
        const permissions = store.permission[sessionID]
        if (!permissions) {
          setStore("permission", sessionID, [event.properties])
          break
        }

        const result = Binary.search(permissions, event.properties.id, (p) => p.id)
        if (result.found) {
          setStore("permission", sessionID, result.index, reconcile(event.properties))
          break
        }

        setStore(
          "permission",
          sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties)
          }),
        )
        break
      }
      case "permission.replied": {
        const permissions = store.permission[event.properties.sessionID]
        if (!permissions) break
        const result = Binary.search(permissions, event.properties.requestID, (p) => p.id)
        if (!result.found) break
        setStore(
          "permission",
          event.properties.sessionID,
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        break
      }
      case "question.asked": {
        const sessionID = event.properties.sessionID
        const questions = store.question[sessionID]
        if (!questions) {
          setStore("question", sessionID, [event.properties])
          break
        }

        const result = Binary.search(questions, event.properties.id, (q) => q.id)
        if (result.found) {
          setStore("question", sessionID, result.index, reconcile(event.properties))
          break
        }

        setStore(
          "question",
          sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties)
          }),
        )
        break
      }
      case "question.replied":
      case "question.rejected": {
        const questions = store.question[event.properties.sessionID]
        if (!questions) break
        const result = Binary.search(questions, event.properties.requestID, (q) => q.id)
        if (!result.found) break
        setStore(
          "question",
          event.properties.sessionID,
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        break
      }
      case "lsp.updated": {
        sdkFor(directory)
          .lsp.status()
          .then((x) => setStore("lsp", x.data ?? []))
        break
      }
      case "skill.updated": {
        sdkFor(directory)
          .app.skills()
          .then((x) => setStore("skill", x.data ?? []))
          .catch(() => {})
        break
      }
    }
  })
  onCleanup(unsub)
  onCleanup(() => {
    if (!timer) return
    clearTimeout(timer)
  })

  async function bootstrap() {
    const health = await globalSDK.client.global
      .health()
      .then((x) => x.data)
      .catch(() => undefined)
    if (!health?.healthy) {
      showToast({
        variant: "error",
        title: language.t("dialog.server.add.error"),
        description: language.t("error.globalSync.connectFailed", { url: globalSDK.url }),
      })
      setGlobalStore("ready", true)
      return
    }

    // One path lookup feeds both the store and the provider catalog; the
    // catalog task used to issue its own path.get before the first resolved.
    const path = retry(() => globalSDK.client.path.get().then((x) => x.data!))
    const tasks = [
      path.then((value) => {
        setGlobalStore("path", value)
      }),
      retry(() =>
        globalSDK.client.global.config.get().then((x) => {
          setGlobalStore("config", x.data!)
        }),
      ),
      retry(() => projectCatalog.refresh()),
      path.then((value) =>
        retry(async () => {
          // The root catalog belongs to the server worktree. Loading it through
          // the same directory-keyed helper lets a direct project route share the
          // in-flight response instead of parsing the catalog twice.
          const directory = value.worktree || value.directory
          setGlobalStore("provider", reconcile(await loadProvider(directory)))
        }),
      ),
      retry(() =>
        globalSDK.client.provider.auth().then((x) => {
          setGlobalStore("provider_auth", x.data ?? {})
        }),
      ),
    ]

    const results = await Promise.allSettled(tasks)
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason)

    if (errors.length) {
      // The toast only carries the first message and never says which task
      // failed, so a bootstrap step can drop out (leaving its store empty and
      // the UI apparently stale) with nothing to point at. Keep the full set.
      console.error("Global bootstrap tasks failed", errors)
      const message = errors[0] instanceof Error ? errors[0].message : String(errors[0])
      const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : ""
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: message + more,
      })
    }

    setGlobalStore("ready", true)
    if (requested.size === 0) interactive("home")
    defer(prefetch, PREFETCH_DELAY_MS)
  }

  onMount(() => {
    bootstrap()
  })

  function projectMeta(directory: string, patch: ProjectMeta) {
    const [store, setStore] = ensureChild(directory)
    const cached = metaCache.get(directory)
    if (!cached) return
    const previous = store.projectMeta ?? {}
    const icon = patch.icon ? { ...(previous.icon ?? {}), ...patch.icon } : previous.icon
    const commands = patch.commands ? { ...(previous.commands ?? {}), ...patch.commands } : previous.commands
    const next = {
      ...previous,
      ...patch,
      icon,
      commands,
    }
    cached.setStore("value", next)
    setStore("projectMeta", next)
  }

  function projectIcon(directory: string, value: string | undefined) {
    const [store, setStore] = ensureChild(directory)
    const cached = iconCache.get(directory)
    if (!cached) return
    if (store.icon === value) return
    cached.setStore("value", value)
    setStore("icon", value)
  }

  async function resolveProject(directory: string) {
    const response = await sdkFor(directory).project.current()
    const project = response.data
    if (!project) throw new Error(`No project found for ${getFilename(directory)}`)
    return rememberProject(project)
  }

  async function resolveProjectID(projectID: string) {
    const response = await sdkFor("", projectID).project.current()
    const project = response.data
    if (!project) throw new Error(`No project found for ${projectID}`)
    return rememberProject(project)
  }

  return {
    data: globalStore,
    set: setGlobalStore,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child,
    bootstrap,
    updateConfig: (config: Config) => {
      setGlobalStore("reload", "pending")
      return globalSDK.client.global.config.update({ config }).finally(() => {
        setTimeout(() => {
          setGlobalStore("reload", "complete")
        }, 1000)
      })
    },
    refreshProviders,
    onProvidersRefreshed: providerRefresh.add,
    onAccountRefreshed: accountRefresh.add,
    project: {
      loadSessions,
      resolve: resolveProject,
      resolveID: resolveProjectID,
      meta: projectMeta,
      icon: projectIcon,
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  // Always mount the shell and provide the context — never blank the whole app while
  // bootstrap round-trips are in flight. The store is usable immediately (seeded from the
  // persisted project cache), and pages hydrate in place using stale-while-revalidate
  // (`.latest`) instead of collapsing to a centered spinner. `value.ready` is still exposed
  // for any child that wants to show an inline loading affordance.
  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
