import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { normalizeStoredArtifact, type StoredArtifact } from "@/artifacts/store"
import { defaultWorkspaceScope, projectScope, workspaceScope } from "./scope"

export type RightPaneTab = "files" | "terminal" | "canvas" | "kernels" | "trace"
export type RightPaneMode = "artifact" | "tools"
export type ContextTab = RightPaneTab | "artifact"
export type ArtifactPaneTab = "details" | "code" | "run" | "messages" | "environment" | "review" | "history"
export type WorkTab =
  | {
      id: `view:${ContextTab}`
      kind: "view"
      context: ContextTab
    }
  | {
      id: string
      kind: "file"
      file: ContextFile
    }
  | {
      id: string
      kind: "saved"
      artifact: StoredArtifact
    }

export interface ContextFile {
  directory: string
  path: string
  name: string
  external?: boolean
}

const AGENT_KEY = "thesis-agent-v1"
const CONTEXT_KEY = "openscience-context-state-v2"

export interface ContextStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface ContextState {
  tab: RightPaneTab
  mode: RightPaneMode
  open: boolean
  /** Every contextual surface currently open in this project. */
  workTabs?: WorkTab[]
  /** The focused contextual tab. */
  activeWorkTab?: string
  /** The active open file. Always a member of `files` when set. */
  file?: ContextFile
  /** The active saved artifact. Its immutable versions live outside scratch. */
  saved?: StoredArtifact
  /** Open-file tabs for this scope, in display order. */
  files?: ContextFile[]
  artifactPaneTab?: ArtifactPaneTab
}

interface PersistedContext {
  version: 2
  scopes: Record<string, ContextState>
}

interface TransientState {
  prefill?: string
  send: boolean
}

// User-selectable agents. A previously-persisted agent that no longer exists (e.g. a
// removed mode) falls back to the default rather than sending an invalid agent.
const VALID_AGENTS = new Set(["research", "biology", "physics", "ml", "plan"])
const TABS = new Set<RightPaneTab>(["files", "terminal", "canvas", "kernels", "trace"])
const MODES = new Set<RightPaneMode>(["artifact", "tools"])
const ARTIFACT_TABS = new Set<ArtifactPaneTab>([
  "details",
  "code",
  "run",
  "messages",
  "environment",
  "review",
  "history",
])

function empty(): ContextState {
  return {
    tab: "files",
    mode: "tools",
    open: false,
  }
}

function slash(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+/g, "/")
}

function normalize(value: string) {
  const input = slash(value)
  const root = input.startsWith("/")
  const drive = input.match(/^[A-Za-z]:/)?.[0]
  const parts = input
    .replace(/^[A-Za-z]:/, "")
    .split("/")
    .filter(Boolean)
    .reduce<string[]>((result, part) => {
      if (part === ".") return result
      if (part === "..") {
        result.pop()
        return result
      }
      result.push(part)
      return result
    }, [])
  const prefix = drive ? `${drive}/` : root ? "/" : ""
  return `${prefix}${parts.join("/")}` || prefix || "."
}

export function resolveContextFile(directory: string, path: string): ContextFile {
  const root = normalize(directory).replace(/\/+$/, "") || "/"
  const input = slash(path)
  const absolute = input.startsWith("/") || /^[A-Za-z]:\//.test(input)
  const full = normalize(absolute ? input : `${root}/${input}`)
  const inside = full.startsWith(`${root}/`)
  if (inside) {
    return {
      directory: root,
      path: full.slice(root.length + 1),
      name: full.split("/").pop() || full,
    }
  }
  return {
    directory: root,
    path: full,
    name: full.split("/").pop() || full,
    external: true,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function restoreFile(value: unknown) {
  const row = record(value)
  if (!row || typeof row.directory !== "string" || typeof row.path !== "string") return
  const file = resolveContextFile(row.directory, row.path)
  if (row.external === true) return { ...file, external: true }
  return file
}

function fileKey(file: ContextFile) {
  return `${file.directory}\n${file.path}`
}

function viewTab(context: ContextTab): WorkTab {
  return {
    id: `view:${context}` as const,
    kind: "view",
    context,
  }
}

function fileTab(file: ContextFile): WorkTab {
  return {
    id: `file:${encodeURIComponent(file.directory)}:${encodeURIComponent(file.path)}`,
    kind: "file",
    file,
  }
}

function savedTab(artifact: StoredArtifact): WorkTab {
  return {
    id: `saved:${artifact.id}`,
    kind: "saved",
    artifact,
  }
}

function restoreWorkTab(value: unknown): WorkTab | undefined {
  const row = record(value)
  if (!row || typeof row.kind !== "string") return
  if (row.kind === "view") {
    if (typeof row.context !== "string") return
    if (row.context !== "artifact" && !TABS.has(row.context as RightPaneTab)) return
    return viewTab(row.context as ContextTab)
  }
  if (row.kind === "saved") {
    const artifact = normalizeStoredArtifact(row.artifact)
    return artifact ? savedTab(artifact) : undefined
  }
  if (row.kind !== "file") return
  const file = restoreFile(row.file)
  if (!file) return
  return fileTab(file)
}

function contextFor(tab: WorkTab): ContextTab {
  if (tab.kind === "view") return tab.context
  return "files"
}

function restoreState(value: unknown): ContextState {
  const row = record(value)
  if (!row) return empty()
  const tab = typeof row.tab === "string" && TABS.has(row.tab as RightPaneTab) ? (row.tab as RightPaneTab) : "files"
  const mode =
    typeof row.mode === "string" && MODES.has(row.mode as RightPaneMode) ? (row.mode as RightPaneMode) : "tools"
  const artifactPaneTab =
    typeof row.artifactPaneTab === "string" && ARTIFACT_TABS.has(row.artifactPaneTab as ArtifactPaneTab)
      ? (row.artifactPaneTab as ArtifactPaneTab)
      : undefined
  const file = restoreFile(row.file)
  const files = (Array.isArray(row.files) ? row.files : [])
    .map(restoreFile)
    .filter((item): item is ContextFile => item !== undefined)
    .filter((item, index, all) => all.findIndex((other) => fileKey(other) === fileKey(item)) === index)
  // The active file is always one of the tabs — sessions persisted before
  // tabs existed carry only `file`.
  if (file && !files.some((item) => fileKey(item) === fileKey(file))) files.unshift(file)
  const restoredTabs = (Array.isArray(row.workTabs) ? row.workTabs : [])
    .map(restoreWorkTab)
    .filter((item): item is WorkTab => item !== undefined)
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
  const fallback = [
    ...(row.open === true || file || files.length > 0 ? [viewTab(mode === "artifact" ? "artifact" : tab)] : []),
    ...files.map(fileTab),
  ]
  const requested = typeof row.activeWorkTab === "string" ? row.activeWorkTab : undefined
  const requestedTab = restoredTabs.find((item) => item.id === requested)
  const owner =
    requestedTab?.kind === "view"
      ? requestedTab.context
      : requestedTab
        ? "files"
        : mode === "artifact"
          ? "artifact"
          : tab
  // Keep every contextual surface mounted. Older sessions can be missing the
  // owning view tab, so add only that tab while preserving the restored strip.
  const workTabs =
    restoredTabs.length > 0 && restoredTabs.some((item) => item.id === `view:${owner}`)
      ? restoredTabs
      : restoredTabs.length > 0
        ? [viewTab(owner), ...restoredTabs]
        : fallback
  const activeWorkTab =
    workTabs.find((item) => item.id === requested)?.id ??
    workTabs.find((item) => item.kind === "file" && file && fileKey(item.file) === fileKey(file))?.id ??
    workTabs[0]?.id
  const active = workTabs.find((item) => item.id === activeWorkTab)
  const activeContext = active ? contextFor(active) : mode === "artifact" ? "artifact" : tab
  // Details is a view of the selected file, not a replacement for it. Keep
  // the owning file selected while the artifact view is active so restoring
  // persisted Details state does not immediately clear artifact ownership.
  const activeFile = active?.kind === "file" ? active.file : activeContext === "artifact" ? file : undefined
  const saved = active?.kind === "saved" ? active.artifact : undefined
  return {
    tab: activeContext === "artifact" ? tab : activeContext,
    mode: activeContext === "artifact" ? "artifact" : "tools",
    open: row.open === true,
    workTabs,
    activeWorkTab,
    file: activeFile,
    saved,
    files,
    artifactPaneTab,
  }
}

function restore(storage: ContextStorage | undefined) {
  if (!storage) return {}
  const raw = (() => {
    try {
      return storage.getItem(CONTEXT_KEY)
    } catch {
      return null
    }
  })()
  if (!raw) return {}
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return
    }
  })()
  const root = record(parsed)
  const scopes = record(root?.scopes)
  if (root?.version !== 2 || !scopes) return {}
  return Object.fromEntries(Object.entries(scopes).map(([scope, value]) => [scope, restoreState(value)]))
}

function browserStorage(): ContextStorage | undefined {
  if (typeof localStorage === "undefined") return
  return localStorage
}

function readAgent(): string {
  try {
    const saved = localStorage.getItem(AGENT_KEY)
    return saved && VALID_AGENTS.has(saved) ? saved : "research"
  } catch {
    return "research"
  }
}

export function createContextState(options: { storage?: ContextStorage } = {}) {
  const storage = options.storage ?? browserStorage()
  const [store, setStore] = createStore({
    scope: defaultWorkspaceScope(),
    transientScope: workspaceScope("__workspace__", "new"),
    scopes: restore(storage) as Record<string, ContextState>,
    transient: {} as Record<string, TransientState>,
  })

  const persist = () => {
    if (!storage) return
    try {
      storage.setItem(
        CONTEXT_KEY,
        JSON.stringify({
          version: 2,
          scopes: store.scopes,
        } satisfies PersistedContext),
      )
    } catch {}
  }

  const current = () => store.scopes[store.scope] ?? empty()
  const transient = () => store.transient[store.transientScope] ?? { send: false }
  const update = (next: ContextState) => {
    setStore("scopes", store.scope, next)
    persist()
  }
  const updateTransient = (next: TransientState) => setStore("transient", store.transientScope, next)
  const context = (): ContextTab => (current().mode === "artifact" ? "artifact" : current().tab)
  const closeContext = () => update({ ...current(), open: false })
  const select = (
    state: ContextState,
    tabs: WorkTab[],
    id: string | undefined,
    files: ContextFile[] = state.files ?? [],
    open = true,
  ): ContextState => {
    const active = tabs.find((item) => item.id === id)
    if (!active) {
      return {
        ...state,
        open: false,
        workTabs: tabs,
        activeWorkTab: undefined,
        file: undefined,
        saved: undefined,
        files,
      }
    }
    const next = contextFor(active)
    return {
      ...state,
      tab: next === "artifact" ? state.tab : next,
      mode: next === "artifact" ? "artifact" : "tools",
      open,
      workTabs: tabs,
      activeWorkTab: active.id,
      // The artifact inspector is contextual to the active file. Clearing the
      // file here unmounts FileView, which clears artifactContext and makes the
      // Details button appear to flash before the pane closes.
      file: active.kind === "file" ? active.file : next === "artifact" ? state.file : undefined,
      saved: active.kind === "saved" ? active.artifact : undefined,
      files,
    }
  }
  const ensure = (tabs: WorkTab[], tab: WorkTab) => {
    if (tabs.some((item) => item.id === tab.id)) return tabs
    return [...tabs, tab]
  }
  const own = (tabs: WorkTab[], next: ContextTab) => ensure(tabs, viewTab(next))
  const closeWorkTab = (id?: string) => {
    const state = current()
    const tabs = state.workTabs ?? []
    const target = tabs.find((item) => item.id === (id ?? state.activeWorkTab))
    if (!target) {
      closeContext()
      return
    }
    const index = tabs.findIndex((item) => item.id === target.id)
    const nextTabs = tabs.filter((item) => item.id !== target.id)
    const files =
      target.kind === "file"
        ? (state.files ?? []).filter((item) => fileKey(item) !== fileKey(target.file))
        : (state.files ?? [])
    if (target.id !== state.activeWorkTab) {
      update({ ...state, workTabs: nextTabs, files })
      return
    }
    const next = nextTabs[index - 1] ?? nextTabs[index] ?? nextTabs[0]
    update(select(state, nextTabs, next?.id, files))
  }
  const syncArtifact = (active: boolean) => {
    if (active || !current().open || context() !== "artifact") return
    const state = current()
    const tabs = state.workTabs ?? []
    const index = tabs.findIndex((item) => item.id === "view:artifact")
    const nextTabs = tabs.filter((item) => item.id !== "view:artifact")
    const next = nextTabs[index - 1] ?? nextTabs[index] ?? nextTabs[0]
    update(select(state, nextTabs, next?.id, state.files ?? [], Boolean(next)))
  }
  const openContext = (next: ContextTab) => {
    const state = current()
    const tabs = own(state.workTabs ?? [], next)
    const id = `view:${next}`
    if (next === "files" && (state.file || state.saved)) {
      update(select(state, tabs, id))
      return
    }
    // Context actions select; they do not also act as an implicit close.
    // Closing is owned by the inspector header, where dirty file drafts can
    // be confirmed before the mounted editors are released.
    if (state.open && state.activeWorkTab === id) return
    update(select(state, tabs, id))
  }
  const openFile = (directory: string, path: string) => {
    const state = current()
    const file = resolveContextFile(directory, path)
    const existing = state.files ?? []
    const known = existing.some((item) => fileKey(item) === fileKey(file))
    const files = known ? existing : [...existing, file]
    // Never evict an open editor implicitly. Its draft lives in the mounted
    // FileView, so the user closes tabs explicitly after saving or confirming.
    const tabs = ensure(own(state.workTabs ?? [], "files"), fileTab(file))
    update(select(state, tabs, fileTab(file).id, files))
  }
  const closeFile = (path?: string) => {
    const state = current()
    const target = path ? (state.files ?? []).find((item) => item.path === path) : state.file
    if (!target) {
      update({ ...state, file: undefined })
      return
    }
    closeWorkTab(fileTab(target).id)
  }
  const openSaved = (artifact: StoredArtifact) => {
    const state = current()
    const tab = savedTab(artifact)
    const tabs = ensure(own(state.workTabs ?? [], "files"), tab)
    update(select(state, tabs, tab.id))
  }
  const updateSaved = (artifact: StoredArtifact) => {
    const state = current()
    const id = savedTab(artifact).id
    if (!(state.workTabs ?? []).some((item) => item.id === id)) return
    update({
      ...state,
      workTabs: (state.workTabs ?? []).map((item) => (item.id === id ? savedTab(artifact) : item)),
      saved: state.activeWorkTab === id ? artifact : state.saved,
    })
  }
  const activateFile = (path: string) => {
    const state = current()
    const target = (state.files ?? []).find((item) => item.path === path)
    if (!target) return
    update(select(state, state.workTabs ?? [], fileTab(target).id))
  }
  const activateWorkTab = (id: string) => {
    const state = current()
    if (!(state.workTabs ?? []).some((item) => item.id === id)) return
    update(select(state, state.workTabs ?? [], id))
  }
  const moveWorkTab = (id: string, to: number) => {
    const state = current()
    const tabs = [...(state.workTabs ?? [])]
    const index = tabs.findIndex((item) => item.id === id)
    if (index === -1) return
    const target = Math.max(0, Math.min(to, tabs.length - 1))
    if (target === index) return
    tabs.splice(target, 0, tabs.splice(index, 1)[0])
    const files = tabs.flatMap((item) => (item.kind === "file" ? [item.file] : []))
    update({ ...state, workTabs: tabs, files })
  }
  const moveFile = (path: string, to: number) => {
    const state = current()
    const target = (state.files ?? []).find((item) => item.path === path)
    if (!target) return
    const positions = (state.workTabs ?? []).flatMap((item, index) => (item.kind === "file" ? [index] : []))
    const destination = positions[Math.max(0, Math.min(to, positions.length - 1))]
    if (destination === undefined) return
    moveWorkTab(fileTab(target).id, destination)
  }

  return {
    scope: () => store.scope,
    activateScope(project: string, session: string) {
      const scope = projectScope(project)
      const legacy = workspaceScope(project, session)
      const remembered = store.scopes[scope]
      if (!remembered && store.scopes[legacy]) {
        setStore("scopes", scope, store.scopes[legacy])
        persist()
      }
      setStore({ scope, transientScope: legacy })
    },
    context,
    open: () => current().open,
    workTabs: () => current().workTabs ?? [],
    activeWorkTab: () => current().activeWorkTab,
    activateWorkTab,
    closeWorkTab,
    moveWorkTab,
    openContext,
    closeContext,
    syncArtifact,
    tab: () => current().tab,
    setTab(tab: RightPaneTab) {
      update({ ...current(), tab })
    },
    mode: () => current().mode,
    setMode(mode: RightPaneMode) {
      update({ ...current(), mode })
    },
    setOpen(open: boolean) {
      update({ ...current(), open })
    },
    file: () => current().file,
    saved: () => current().saved,
    files: () => current().files ?? [],
    openFile,
    openSaved,
    updateSaved,
    closeFile,
    activateFile,
    moveFile,
    artifactPaneTab: () => current().artifactPaneTab,
    setArtifactPaneTab(tab: ArtifactPaneTab | undefined) {
      update({ ...current(), artifactPaneTab: tab })
    },
    prefill: () => transient().prefill,
    setPrefill(prefill: string | undefined) {
      updateTransient({ ...transient(), prefill })
    },
    prefillSend: () => transient().send,
    setPrefillSend(send: boolean) {
      updateTransient({ ...transient(), send })
    },
  }
}

const [helpOpen, setHelpOpen] = createSignal(false)
const [paletteOpen, setPaletteOpen] = createSignal(false)
const state = createContextState()
const [agent, setAgentRaw] = createSignal<string>(readAgent())

function setAgent(name: string) {
  try {
    localStorage.setItem(AGENT_KEY, name)
  } catch {}
  setAgentRaw(name)
}

export const uiStore = {
  helpOpen,
  setHelpOpen,
  paletteOpen,
  setPaletteOpen,
  scope: state.scope,
  activateScope: state.activateScope,
  context: state.context,
  open: state.open,
  workTabs: state.workTabs,
  activeWorkTab: state.activeWorkTab,
  activateWorkTab: state.activateWorkTab,
  closeWorkTab: state.closeWorkTab,
  moveWorkTab: state.moveWorkTab,
  openContext: state.openContext,
  closeContext: state.closeContext,
  syncArtifact: state.syncArtifact,
  rightPaneTab: state.tab,
  setRightPaneTab: state.setTab,
  rightPaneMode: state.mode,
  setRightPaneMode: state.setMode,
  rightPaneOpen: state.open,
  setRightPaneOpen: state.setOpen,
  file: state.file,
  saved: state.saved,
  files: state.files,
  openFile: state.openFile,
  openSaved: state.openSaved,
  updateSaved: state.updateSaved,
  closeFile: state.closeFile,
  activateFile: state.activateFile,
  moveFile: state.moveFile,
  artifactPaneTab: state.artifactPaneTab,
  setArtifactPaneTab: state.setArtifactPaneTab,
  agent,
  setAgent,
  prefill: state.prefill,
  setPrefill: state.setPrefill,
  prefillSend: state.prefillSend,
  setPrefillSend: state.setPrefillSend,
}
