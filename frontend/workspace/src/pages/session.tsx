import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { createMediaQuery } from "@solid-primitives/media"
import { SessionTurn } from "@synsci/ui/session-turn"
import { createAutoScroll } from "@synsci/ui/hooks"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useTerminal } from "@/context/terminal"
import { PromptInput } from "@/components/prompt-input"
import { AsciiSpinner } from "@/atlas/shared/AsciiSpinner"
import { AppHeader } from "@/atlas/AppHeader"
import { FONT_SANS } from "@/styles/tokens"
import { uiStore } from "@/atlas/store/ui"
import { useGlobalKeys } from "@/atlas/useGlobalKeys"
import { useDialog } from "@synsci/ui/context/dialog"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"
import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { confirmDialog } from "@/atlas/dialogs"
import { DialogSettings } from "@/components/dialog-settings"
import { SessionSidebarActions, SidebarAction, type SessionContext } from "@/pages/session-sidebar-action"
import { DisconnectedPanel } from "@/atlas/DisconnectedPanel"
import { CommandPalette } from "@/atlas/CommandPalette"
import { HelpOverlay } from "@/atlas/HelpOverlay"
import { ToastContainer } from "@/atlas/Toast"
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconHome,
  IconPlus,
  IconSearch,
  IconSettings,
  IconMessageSquare,
  IconMoreH,
  IconPin,
  IconPinFilled,
  IconShield,
  IconX,
} from "@/atlas/shared/Icon"
import { StatusDot } from "@/atlas/shared/StatusDot"
import { IconTrash } from "@/atlas/shared/Icon"
import { toast } from "@/atlas/Toast"
import { artifactContext } from "@/artifacts/context"
import { createSessionTabs } from "@/atlas/store/sessionTabs"
import { terminalEndpointAvailable } from "@/atlas/terminal-endpoint"
import { productPreferences, type ProductPreferences } from "@/context/product-preferences"
import { SIDEBAR_WIDTH, clampSidebarWidth } from "@/pages/session-sidebar-size"
import { URLS } from "@/config/urls"
import { SessionTabStrip, sessionTabID, type SessionTabItem } from "@/pages/session-tabs"
import { sessionUnavailable } from "@/pages/session-availability"
import { publicContextAvailable, sanitizePublicContexts } from "@/pages/public-contexts"
import { useExecutionAuthority } from "@/atlas/use-execution-authority"
import "./session-header.css"
import "../components/chat-surface.css"

type SyncSession = ReturnType<typeof useSync>["data"]["session"][number]

/**
 * Session page — new visual identity (Synthetic Sciences wordmark + sessions
 * sidebar + conversation workspace + contextual files and research pane) wrapping
 * the unchanged openscience backend chat (SessionTurn rendering, PromptInput,
 * real SSE streaming, sub-task delegation, tool calls, TODOs, diff cards).
 */
const sessionSidebarKey = "openscience-session-sidebar-v1"
const sessionSidebarWidthKey = "openscience-session-sidebar-width-v1"
const traceExpansionKey = "openscience-trace-expansion-v1"

function readSessionSidebar() {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(sessionSidebarKey) === "collapsed"
  } catch {
    return false
  }
}

function writeSessionSidebar(collapsed: boolean) {
  try {
    localStorage.setItem(sessionSidebarKey, collapsed ? "collapsed" : "expanded")
  } catch {}
}

function readSessionSidebarWidth() {
  if (typeof localStorage === "undefined") return SIDEBAR_WIDTH.initial
  try {
    const value = Number.parseFloat(localStorage.getItem(sessionSidebarWidthKey) ?? "")
    return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_WIDTH.initial
  } catch {
    return SIDEBAR_WIDTH.initial
  }
}

function writeSessionSidebarWidth(width: number) {
  try {
    localStorage.setItem(sessionSidebarWidthKey, clampSidebarWidth(width).toString())
  } catch {}
}

function readTraceExpansion() {
  if (typeof localStorage === "undefined") return {} as Record<string, boolean>
  try {
    const value: unknown = JSON.parse(localStorage.getItem(traceExpansionKey) ?? "{}")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, true] => entry[1] === true),
    )
  } catch {
    return {}
  }
}

function writeTraceExpansion(value: Record<string, boolean>) {
  try {
    const entries = Object.entries(value).filter((entry): entry is [string, true] => entry[1] === true)
    localStorage.setItem(traceExpansionKey, JSON.stringify(Object.fromEntries(entries.slice(-200))))
  } catch {}
}

export default function Page(): JSX.Element {
  const params = useParams()
  const navigate = useNavigate()
  const sync = useSync()
  const sdk = useSDK()
  const layout = useLayout()
  const prompt = usePrompt()
  const terminal = useTerminal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const [creating, setCreating] = createSignal(false)
  const pending: { value?: Promise<string | undefined>; context?: SessionContext } = {}
  const [mobileSessionsOpen, setMobileSessionsOpen] = createSignal(false)
  const [sessionsCollapsed, setSessionsCollapsed] = createSignal(readSessionSidebar())
  const [sessionsWidth, setSessionsWidth] = createSignal(readSessionSidebarWidth())
  const sessionTabs = createSessionTabs()
  const hydration = new Map<string, Promise<void>>()
  const prewarmed = new Set<string>()

  const hydrateSession = (id: string) => {
    const pending = hydration.get(id)
    if (pending) return pending
    const request = sync.session.sync(id).finally(() => hydration.delete(id))
    hydration.set(id, request)
    return request
  }

  const discardUnavailableSession = (id: string, error: unknown) => {
    if (!sessionUnavailable(error)) return false
    prewarmed.delete(id)
    const target = sessionTabs.close(id)
    if (params.id === id) {
      toast.error("Session is no longer available")
      navigate(target ? `/${params.dir}/session/${target}` : `/${params.dir}/session/new`, { replace: true })
    }
    return true
  }

  createEffect(
    on(
      () => server.url,
      (url) => {
        productPreferences.sync({ show_trace: false, atlas_enabled: false, show_local_models: true })
        if (!url) return
        const endpoint = `${url.replace(/\/$/, "")}/settings/preferences`
        void (platform.fetch ?? fetch)(endpoint)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Preferences unavailable"))))
          .then((preferences) => productPreferences.sync(preferences as ProductPreferences))
          .catch(() => productPreferences.sync({ show_trace: false, atlas_enabled: false, show_local_models: true }))
      },
    ),
  )

  createEffect(on(uiStore.scope, () => sanitizePublicContexts(uiStore)))

  function newSession() {
    if (!params.id || params.id === "new") {
      prompt.reset()
      return
    }
    navigate(`/${params.dir}/session/new`)
  }

  async function ensureSession() {
    if (params.id && params.id !== "new") return params.id
    const context = uiStore.context()
    if (context === "terminal") {
      pending.context = context as SessionContext
    }
    if (pending.value) return pending.value
    setCreating(true)
    const task = sdk.client.session
      .create()
      .then((res) => {
        const data = res.data
        const id = data?.id
        if (!id) return
        const context = pending.context
        if (context) {
          uiStore.activateScope(sdk.scope, id)
          uiStore.openContext(context)
        }
        navigate(`/${params.dir}/session/${id}`)
        return id
      })
      .catch(() => undefined)
      .finally(() => {
        pending.value = undefined
        pending.context = undefined
        setCreating(false)
      })
    pending.value = task
    return task
  }

  const openContext = (context: SessionContext) => {
    if (!publicContextAvailable(context)) return
    uiStore.openContext(context)
    if (context !== "terminal") return
    void ensureSession()
  }

  async function deleteSession(sessionID: string) {
    const ok = await confirmDialog(dialog, {
      title: "Delete this session?",
      message: "This removes the conversation and its session workspace. Saved Results stay available.",
      confirmLabel: "Delete session",
      danger: true,
    })
    if (!ok) return
    // Capture the next-active id BEFORE the optimistic splice so we
    // know where to navigate.
    const active = params.id === sessionID
    const next = sessions().find((s) => s.id !== sessionID)?.id
    try {
      await sync.session.delete(sessionID)
      const open = sessionTabs.close(sessionID)
      toast.info("Session deleted")
      if (active) {
        const target = open ?? next
        navigate(target ? `/${params.dir}/session/${target}` : `/${params.dir}/session/new`)
      }
    } catch (error: unknown) {
      console.error("session.delete failed", error)
      toast.error("Could not delete session", error instanceof Error ? error.message : String(error))
    }
  }

  async function renameSession(sessionID: string, title: string): Promise<boolean> {
    const trimmed = title.trim()
    if (!trimmed) return false
    try {
      await sync.session.rename(sessionID, trimmed)
      return true
    } catch (error: unknown) {
      console.error("session.rename failed", error)
      toast.error("Could not rename session", error instanceof Error ? error.message : String(error))
      return false
    }
  }

  async function pinSession(sessionID: string, pinned: boolean) {
    await sync.session.pin(sessionID, pinned).catch((error: unknown) => {
      toast.error("Could not update pin", error instanceof Error ? error.message : String(error))
    })
  }

  function toggleSessions() {
    const next = !sessionsCollapsed()
    setSessionsCollapsed(next)
    writeSessionSidebar(next)
  }

  // Force-load the session list into the sync store every time we land
  // on a project. sync.session.fetch() calls session.list AND reconciles
  // the result into the per-directory store; the raw SDK call alone
  // doesn't.
  createEffect(
    on(
      () => params.dir,
      () => {
        ;(async () => {
          try {
            await sync.session.fetch(50)
          } catch {}
        })()
      },
    ),
  )

  // When the active session id changes, hydrate that session's messages
  // (and parts) into the store. Without this the chat panel shows blank
  // when you click an existing session — sync.session.sync() pulls the
  // backend's stored messages in.
  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id || id === "new") return
        ;(async () => {
          try {
            await hydrateSession(id)
          } catch (error) {
            discardUnavailableSession(id, error)
          }
        })()
      },
    ),
  )

  // Hydrate child (sub-agent) sessions of the active session regardless of
  // which right-pane tab is open, so the inline turn status and back-to-parent
  // navigation populate immediately and survive a reload.
  const hydratedChildren = new Set<string>()
  createEffect(() => {
    const id = params.id
    if (!id || id === "new") return
    for (const child of sync.data.session) {
      if (child.parentID !== id || hydratedChildren.has(child.id)) continue
      hydratedChildren.add(child.id)
      void sync.session.sync(child.id).catch(() => {})
    }
  })

  const project = createMemo(() => sync.project)
  const projectName = () => {
    const configured = project()?.name?.trim()
    if (configured) return configured
    const p = projectPath()
    const segs = p.split("/").filter(Boolean)
    return segs[segs.length - 1] ?? p
  }
  const projectPath = () => sdk.directory
  const sessions = createMemo<SyncSession[]>(() =>
    [...sync.data.session]
      .filter((s) => !s.parentID)
      .sort(
        (a, b) =>
          Number(Boolean(b.time?.pinned)) - Number(Boolean(a.time?.pinned)) ||
          (b.time?.pinned ?? 0) - (a.time?.pinned ?? 0) ||
          (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
      ),
  )

  createEffect(
    on(
      () => [sdk.scope, params.id] as const,
      ([scope, id]) => {
        sessionTabs.activateProject(scope)
        if (!id || id === "new") return
        sessionTabs.open(id)
      },
    ),
  )

  createEffect(() => {
    const id = params.id
    if (!id || id === "new") return
    sessionTabs.setDraft(id, prompt.dirty())
  })

  createEffect(() => {
    const id = params.id
    if (!id || id === "new") return
    const updated = sessions().find((session) => session.id === id)?.time?.updated ?? 0
    if (!updated) return
    sessionTabs.markRead(id, updated)
  })

  const openSessions = createMemo<SessionTabItem[]>(() => {
    const tabs = sessionTabs.tabs().map((id) => {
      const session = sessions().find((item) => item.id === id)
      const updated = session?.time?.updated ?? 0
      return {
        id,
        title: session?.title?.trim() || "Session",
        working: Boolean(sync.data.session_status?.[id] && sync.data.session_status[id].type !== "idle"),
        dirty: sessionTabs.dirty(id),
        unread: sessionTabs.unread(id, updated),
        editable: true,
        closable: true,
        reorderable: true,
      }
    })
    if (params.id && params.id !== "new") return tabs
    return [
      ...tabs,
      {
        id: "new",
        title: "New session",
        working: false,
        dirty: prompt.dirty(),
        unread: false,
        editable: false,
        closable: tabs.length > 0,
        reorderable: false,
      },
    ]
  })

  const closeSessionTab = (id: string) => {
    if (id === "new") {
      const target = sessionTabs.active() ?? sessionTabs.tabs().at(-1)
      if (target) navigate(`/${params.dir}/session/${target}`)
      return target ?? "new"
    }
    const target = sessionTabs.close(id)
    if (params.id !== id) return params.id ?? sessionTabs.active() ?? "new"
    navigate(target ? `/${params.dir}/session/${target}` : `/${params.dir}/session/new`)
    return target ?? "new"
  }

  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const lastUserMessage = createMemo(() => {
    const ms = messages()
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === "user") return ms[i]
  })
  // A SessionTurn renders nothing for an assistant message — it only renders
  // when handed a user message, gathering that turn's assistant replies itself.
  // So render exactly one turn per user message; iterating every message made
  // each of the (often hundreds of) assistant messages paint an empty turn plus
  // a divider, which stacked up as faint horizontal lines down the chat and
  // bloated the DOM (slowing the reflow when the right pane opens).
  // When the session is in a reverted state, turns at or past the revert point
  // stay hidden until the user restores them or sends a new message (which
  // makes the revert permanent server-side).
  const activeSession = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const childSessions = createMemo(() => {
    const parent = activeSession()?.parentID
    if (!parent) return []
    return sync.data.session
      .filter((session) => session.parentID === parent)
      .toSorted((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || a.id.localeCompare(b.id))
  })
  const childIndex = createMemo(() => childSessions().findIndex((session) => session.id === params.id))
  const previousChild = createMemo(() => {
    const index = childIndex()
    if (index <= 0) return
    return childSessions()[index - 1]
  })
  const nextChild = createMemo(() => {
    const index = childIndex()
    if (index < 0 || index >= childSessions().length - 1) return
    return childSessions()[index + 1]
  })
  const revertInfo = createMemo(() => activeSession()?.revert)
  // A `path.md` mentioned in an assistant message dispatches this. Keep the
  // transcript mounted and open the file in the contextual Files pane.
  onMount(() => {
    const onOpenFile = (e: Event) => {
      const path = (e as CustomEvent).detail?.path
      if (typeof path !== "string" || !path) return
      uiStore.openFile(projectPath(), path)
    }
    document.addEventListener("openscience:open-file", onOpenFile)
    const onOpenContext = (event: Event) => {
      const context = (event as CustomEvent).detail?.context
      if (!(["files", "terminal", "canvas", "kernels", "trace"] as SessionContext[]).includes(context)) return
      openContext(context)
    }
    document.addEventListener("openscience:open-context", onOpenContext)
    onCleanup(() => {
      document.removeEventListener("openscience:open-file", onOpenFile)
      document.removeEventListener("openscience:open-context", onOpenContext)
    })
  })
  const turnMessages = createMemo(() => {
    const revertID = revertInfo()?.messageID
    return messages().filter((m) => m.role === "user" && (!revertID || m.id < revertID))
  })
  const sessionStatus = createMemo(() =>
    params.id ? (sync.data.session_status?.[params.id] as { type?: string } | undefined)?.type : undefined,
  )
  // A message is a compaction boundary when it carries a `compaction` part.
  const hasCompactionPart = (id: string) => (sync.data.part[id] ?? []).some((p) => p.type === "compaction")
  // While compacting, an inline loader replaces the divider on the compaction
  // message currently being summarized (the most recent one). Once compaction
  // finishes the status leaves "compacting" and it becomes the "context
  // compacted" divider; older boundaries always render as dividers.
  const compactingMessageId = createMemo(() => {
    if (sessionStatus() !== "compacting") return undefined
    const msgs = turnMessages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (hasCompactionPart(msgs[i].id)) return msgs[i].id
    }
    return undefined
  })
  const revertedCount = createMemo(() => {
    const revertID = revertInfo()?.messageID
    if (!revertID) return 0
    return messages().filter((m) => m.role === "user" && m.id >= revertID).length
  })

  const revertTo = async (messageID: string) => {
    const id = params.id
    if (!id) return
    const ok = await confirmDialog(dialog, {
      title: "Undo from here?",
      message:
        "Hides this message and everything after it, and rolls back the file changes they made. You can restore until you send the next message.",
      confirmLabel: "Undo",
      danger: true,
    })
    if (!ok) return
    try {
      await sync.session.revert(id, messageID)
      toast.success("Reverted", "Files rolled back. Send a message to continue from here.")
    } catch (e: any) {
      toast.error("Undo failed", e?.message ?? String(e))
    }
  }

  const restoreRevert = async () => {
    const id = params.id
    if (!id) return
    try {
      await sync.session.unrevert(id)
      toast.success("Messages restored")
    } catch (e: any) {
      toast.error("Restore failed", e?.message ?? String(e))
    }
  }

  // Undo/redo were orphaned when the chat surface was reskinned — revertTo()
  // had no trigger. Re-expose them as first-class commands (palette + /undo,
  // /redo slash) so undo works again. Undo reverts the last turn; redo restores
  // a pending revert until the next message makes it permanent.
  const commands = useCommand()
  const language = useLanguage()
  const showTerminal = () => {
    if (uiStore.context() === "terminal" && uiStore.open()) return
    openContext("terminal")
  }
  commands.register(() => {
    const id = params.id
    const list: CommandOption[] = []
    list.push(
      {
        id: "session.new",
        title: "New session",
        description: "Start a new research conversation",
        category: "Session",
        onSelect: newSession,
      },
      {
        id: "project.files",
        title: "Open project files",
        description: "Browse, preview, and edit files in this project",
        category: "Project",
        onSelect: () => openContext("files"),
      },
      {
        id: "project.compute",
        title: "Open project compute",
        description: "View local executions, live runtimes, and remote jobs",
        category: "Project",
        onSelect: () => openContext("kernels"),
      },
      ...(artifactContext.active()
        ? [
            {
              id: "file.details",
              title: "Open file details",
              description: "Inspect the active file and its provenance",
              category: "Project",
              onSelect: () => openContext("artifact"),
            } satisfies CommandOption,
          ]
        : []),
      {
        id: "settings.open",
        title: "Open settings",
        description: "Configure models, capabilities, runtime, and the app",
        category: "Application",
        onSelect: () => dialog.show(() => <DialogSettings />),
      },
      {
        id: "project.home",
        title: "Back to projects",
        description: "Return to the projects home",
        category: "Navigation",
        onSelect: () => navigate("/"),
      },
      {
        id: "documentation.open",
        title: "Open documentation",
        description: "Read the Synthetic Sciences documentation",
        category: "Help",
        onSelect: () => platform.openLink(URLS.site),
      },
      {
        id: "terminal.toggle",
        title: language.t("command.terminal.toggle"),
        description: "Open or close the project terminal",
        category: language.t("command.category.terminal"),
        keybind: "ctrl+`",
        onSelect: () => openContext("terminal"),
      },
      {
        id: "terminal.new",
        title: language.t("command.terminal.new"),
        description: language.t("command.terminal.new.description"),
        category: language.t("command.category.terminal"),
        keybind: "ctrl+shift+`",
        disabled: !terminalEndpointAvailable(sdk.url) || !id || id === "new",
        onSelect: () => {
          showTerminal()
          void terminal.new().catch((cause: unknown) => {
            toast.error("Could not start terminal", cause instanceof Error ? cause.message : String(cause))
          })
        },
      },
    )
    if (!id || id === "new") return list
    const last = lastUserMessage()
    if (last && !revertInfo()) {
      list.push({
        id: "session.undo",
        title: language.t("command.session.undo"),
        description: language.t("command.session.undo.description"),
        category: language.t("command.category.session"),
        slash: "undo",
        onSelect: () => void revertTo(last.id),
      })
    }
    if (revertInfo()) {
      list.push({
        id: "session.redo",
        title: language.t("command.session.redo"),
        description: language.t("command.session.redo.description"),
        category: language.t("command.category.session"),
        slash: "redo",
        onSelect: () => void restoreRevert(),
      })
    }
    const failure = (error: unknown) => {
      if (error && typeof error === "object" && "data" in error) {
        const data = (error as { data?: { message?: string } }).data
        if (data?.message) return data.message
      }
      if (error instanceof Error) return error.message
      return "Request failed"
    }
    const action = (name: string, title: string, description: string) => ({
      id: `session.${name}`,
      title,
      description,
      category: language.t("command.category.session"),
      slash: name,
      onSelect: () => {
        const last = lastUserMessage()
        const request = {
          sessionID: id,
          command: name,
          arguments: "",
          effort: last?.role === "user" ? (last.effort ?? "normal") : "normal",
          delegation: last?.role === "user" ? (last.delegation ?? true) : true,
        } satisfies Parameters<typeof sdk.client.session.command>[0] & {
          effort: "normal" | "ultra"
          delegation: boolean
        }
        void sdk.client.session.command(request).catch((error: unknown) => {
          console.error(`${name} failed`, error)
          toast.error(`Could not run /${name}`, failure(error))
        })
      },
    })
    list.push(
      action("status", "Session status", "Show live plan, artifact, and workspace state"),
      action("context", "Context usage", "Show context composition, capacity, and compaction state"),
      action("stop", "Stop active work", "Stop the active response in this session"),
      action("compact", "Compact conversation", "Summarize the conversation to free up context"),
      action("handoff", "Write handoff & compact", "Save a resumable handoff, then compact"),
      action("checkpoint", "Save checkpoint", "Capture a local recovery packet from current session state"),
    )
    return list
  })

  const [stepsExpanded, setStepsExpanded] = createSignal<Record<string, boolean>>(readTraceExpansion())
  const toggleSteps = (id: string) =>
    setStepsExpanded((previous) => {
      const next = { ...previous, [id]: !previous[id] }
      writeTraceExpansion(next)
      return next
    })

  useGlobalKeys({ onNew: newSession })

  // The center belongs to the conversation for the lifetime of the route.
  // Files and other research surfaces mount only in the right context pane.
  const chatTitle = createMemo(() => {
    if (!params.id || params.id === "new") return "New session"
    return activeSession()?.title?.trim() || "Session"
  })
  // Chat scroll: stick to the bottom while the agent streams; detach the
  // moment the user scrolls up (a "jump to latest" button re-attaches).
  // Follow is driven by content growth (ResizeObserver on the content
  // wrapper), not message count, so streamed part updates keep the view
  // pinned instead of only re-anchoring on new messages / container resize.
  const working = createMemo(() => {
    const id = params.id
    if (!id) return false
    const status = sync.data.session_status?.[id]
    return !!status && status.type !== "idle"
  })

  const chatScroll = createAutoScroll({
    working,
    overflowAnchor: "dynamic",
    // A small threshold keeps live output pinned only when the reader is
    // genuinely at the bottom. The old 120px zone repeatedly recaptured users
    // who had started scrolling through tool output.
    bottomThreshold: 24,
  })
  const sessionKey = createMemo(() => `${sdk.scope}/${params.id ?? "new"}`)
  const chatView = layout.view(sessionKey)
  const restoration: {
    target?: {
      scope: string
      x: number
      y: number
    }
  } = {}
  let chatElement: HTMLDivElement | undefined
  let contentElement: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  let conversationPanelElement: HTMLElement | undefined
  let promptDockElement: HTMLDivElement | undefined
  let promptDockObserver: ResizeObserver | undefined

  const cancelRestoration = () => {
    restoration.target = undefined
  }

  const applyRestoration = () => {
    const target = restoration.target
    const element = chatElement
    if (!target || !element || target.scope !== sessionKey()) return
    element.scrollLeft = target.x
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    if (max + 1 < target.y) {
      element.scrollTop = max
      return
    }
    restoration.target = undefined
    element.scrollTop = target.y
    chatScroll.handleScroll()
  }

  // Restore one exact position per scoped conversation. Resize observation
  // handles progressively rendered markdown without repeated timers; the first
  // wheel/pointer interaction cancels restoration immediately.
  createEffect(
    on(
      () => [sessionKey(), messages().length > 0] as const,
      ([scope, hasMessages]) => {
        restoration.target = undefined
        if (!hasMessages) return
        const frame = requestAnimationFrame(() => {
          if (scope !== sessionKey()) return
          const saved = chatView.scroll("conversation")
          if (!saved) {
            chatScroll.forceScrollToBottom()
            return
          }
          restoration.target = { scope, x: saved.x, y: saved.y }
          applyRestoration()
        })
        onCleanup(() => cancelAnimationFrame(frame))
      },
    ),
  )

  createEffect(() => {
    if (project()) layout.projects.open(project()!.worktree)
  })

  onMount(() => {
    observer = new ResizeObserver(applyRestoration)
    if (contentElement) observer.observe(contentElement)

    const measurePromptDock = () => {
      if (!conversationPanelElement || !promptDockElement) return
      const height = Math.ceil(promptDockElement.getBoundingClientRect().height)
      if (height <= 0) return
      conversationPanelElement.style.setProperty("--workspace-composer-height", `${height}px`)
    }

    measurePromptDock()
    promptDockObserver = new ResizeObserver(measurePromptDock)
    if (promptDockElement) promptDockObserver.observe(promptDockElement)

    onCleanup(() => {
      observer?.disconnect()
      promptDockObserver?.disconnect()
    })
  })

  return (
    <div
      class="atlas-root"
      style={{
        flex: 1,
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        overflow: "hidden",
        background: "var(--color-bg)",
      }}
    >
      <ToastContainer />
      <HelpOverlay open={uiStore.helpOpen()} onClose={() => uiStore.setHelpOpen(false)} />
      <CommandPalette open={uiStore.paletteOpen()} onClose={() => uiStore.setPaletteOpen(false)} />

      <DisconnectedPanel />

      <div
        class="session-workspace"
        data-context-open={uiStore.rightPaneOpen() ? "true" : "false"}
        style={{
          flex: 1,
          "min-height": 0,
          "min-width": 0,
          display: "flex",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <Show when={mobileSessionsOpen()}>
          <button
            type="button"
            class="session-sidebar-backdrop"
            aria-label="Close sessions"
            onClick={() => setMobileSessionsOpen(false)}
          />
        </Show>
        <SessionsSidebar
          projectName={projectName()}
          sessions={sessions()}
          activeId={params.id}
          dirParam={params.dir ?? ""}
          creating={creating()}
          collapsed={sessionsCollapsed()}
          width={sessionsWidth()}
          mobileOpen={mobileSessionsOpen()}
          onCloseMobile={() => setMobileSessionsOpen(false)}
          onNew={() => {
            setMobileSessionsOpen(false)
            newSession()
          }}
          onBack={() => navigate("/")}
          onCollapse={toggleSessions}
          onResize={(width, done) => {
            const next = clampSidebarWidth(width)
            setSessionsWidth(next)
            if (done) writeSessionSidebarWidth(next)
          }}
          onSearch={() => {
            setMobileSessionsOpen(false)
            uiStore.setPaletteOpen(true)
          }}
          onCustomize={() => {
            setMobileSessionsOpen(false)
            dialog.show(() => <DialogSettings />)
          }}
          onContext={(context) => {
            setMobileSessionsOpen(false)
            openContext(context)
          }}
          context={uiStore.context()}
          contextOpen={uiStore.open()}
          artifact={Boolean(artifactContext.active())}
          onSelect={(id) => {
            setMobileSessionsOpen(false)
            sessionTabs.open(id)
            navigate(`/${params.dir}/session/${id}`)
          }}
          onWarm={(id) => {
            if (id === params.id || prewarmed.has(id)) return
            prewarmed.add(id)
            void hydrateSession(id).catch((error) => {
              if (!discardUnavailableSession(id, error)) prewarmed.delete(id)
            })
          }}
          onDelete={(id) => void deleteSession(id)}
          onRename={(id, title) => void renameSession(id, title)}
          onPin={(id, pinned) => void pinSession(id, pinned)}
        />

        <div
          class="session-main"
          style={{
            flex: 1,
            "min-width": 0,
            "min-height": 0,
            display: "flex",
            "flex-direction": "column",
            background: "var(--color-bg)",
            overflow: "hidden",
          }}
        >
          <Header
            title={chatTitle()}
            tabs={openSessions()}
            active={params.id ?? "new"}
            onSelect={(id) => {
              if (id !== "new") sessionTabs.open(id)
              navigate(`/${params.dir}/session/${id}`)
            }}
            onClose={closeSessionTab}
            onReorder={(id, to) => sessionTabs.move(id, to)}
            onRename={renameSession}
            onWarm={(id) => {
              if (id === "new" || id === params.id || prewarmed.has(id)) return
              prewarmed.add(id)
              void hydrateSession(id).catch((error) => {
                if (!discardUnavailableSession(id, error)) prewarmed.delete(id)
              })
            }}
            onBack={() => navigate("/")}
            onToggleSessions={() => setMobileSessionsOpen((open) => !open)}
          />
          <div
            style={{
              flex: 1,
              "min-height": 0,
              "min-width": 0,
              position: "relative",
              display: "flex",
              "flex-direction": "column",
            }}
          >
            {/* conversation center — never replaced by file navigation */}
            <section
              ref={(element) => (conversationPanelElement = element)}
              id="session-conversation-panel"
              role="tabpanel"
              aria-labelledby={sessionTabID(params.id ?? "new")}
              data-component="conversation-center"
              aria-label="Conversation"
              style={{
                display: "flex",
                flex: 1,
                "min-height": 0,
                "flex-direction": "column",
                position: "relative",
              }}
            >
              <Switch>
                <Match when={params.id && messages().length > 0}>
                  {/* Scoped to just the scroll area (not the revert banner / Composer
                      below) so the jump-to-latest pill's position:absolute resolves
                      against this box instead of the whole chat column. */}
                  <div
                    class="session-conversation-scroll-frame"
                    style={{
                      position: "relative",
                      flex: 1,
                      "min-height": 0,
                      display: "flex",
                      "flex-direction": "column",
                    }}
                  >
                    <div
                      ref={(element) => {
                        chatElement = element
                        chatScroll.scrollRef(element)
                      }}
                      onScroll={(event) => {
                        chatScroll.handleScroll()
                        if (restoration.target) return
                        chatView.setScroll("conversation", {
                          x: event.currentTarget.scrollLeft,
                          y: event.currentTarget.scrollTop,
                        })
                      }}
                      onWheel={cancelRestoration}
                      onPointerDown={cancelRestoration}
                      onClick={chatScroll.handleInteraction}
                      class="atlas-scroll atlas-chat-scroll session-scroller"
                      style={{
                        flex: 1,
                        "min-height": 0,
                        "overflow-y": "auto",
                        "overflow-x": "hidden",
                      }}
                    >
                      {/* Delegated work keeps its own identity and sibling navigation.
                          This remains outside contentRef so the ResizeObserver measures
                          only the growing message list. */}
                      <Show when={activeSession()?.parentID}>
                        <div class="sticky top-0 z-30 bg-background-stronger w-full">
                          <div class="w-full px-4 md:px-6 md:max-w-200 md:mx-auto">
                            <div class="min-h-12 py-1.5 flex items-center gap-2 border-b border-border-weak-base">
                              <div class="min-w-0 flex-1">
                                <div class="text-[10px] tracking-[0.04em] text-text-weaker">Delegated agent</div>
                                <div class="truncate text-xs font-medium text-text-base">
                                  {activeSession()?.title?.trim() || "Research task"}
                                </div>
                              </div>
                              <div
                                class="flex items-center gap-1"
                                role="navigation"
                                aria-label="Delegated agent sessions"
                              >
                                <button
                                  type="button"
                                  class="h-7 px-2 flex items-center gap-1 rounded-md text-xs text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors"
                                  aria-label="Back to parent session"
                                  onClick={() => navigate(`/${params.dir}/session/${activeSession()!.parentID}`)}
                                >
                                  <IconChevronLeft size={13} strokeWidth={1.6} />
                                  Parent
                                </button>
                                <button
                                  type="button"
                                  class="size-7 flex items-center justify-center rounded-md text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors disabled:opacity-30 disabled:pointer-events-none"
                                  aria-label="Previous delegated agent"
                                  disabled={!previousChild()}
                                  onClick={() => navigate(`/${params.dir}/session/${previousChild()!.id}`)}
                                >
                                  <IconChevronLeft size={13} strokeWidth={1.6} />
                                </button>
                                <span class="min-w-10 text-center text-[11px] text-text-weaker">
                                  {Math.max(0, childIndex()) + 1}/{childSessions().length}
                                </span>
                                <button
                                  type="button"
                                  class="size-7 flex items-center justify-center rounded-md text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors disabled:opacity-30 disabled:pointer-events-none"
                                  aria-label="Next delegated agent"
                                  disabled={!nextChild()}
                                  onClick={() => navigate(`/${params.dir}/session/${nextChild()!.id}`)}
                                >
                                  <IconChevronRight size={13} strokeWidth={1.6} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </Show>

                      {/* Centered conversation column with 2px between-turn divider */}
                      <div
                        ref={(element) => {
                          contentElement = element
                          chatScroll.contentRef(element)
                          observer?.disconnect()
                          observer?.observe(element)
                        }}
                        class="session-transcript w-full flex flex-col items-start justify-start"
                      >
                        <For each={turnMessages()}>
                          {(message, index) => (
                            <div data-message-id={message.id} class="min-w-0 w-full max-w-full">
                              <Show
                                when={!hasCompactionPart(message.id)}
                                fallback={
                                  <Show
                                    when={message.id === compactingMessageId()}
                                    fallback={
                                      <div
                                        style={{
                                          display: "flex",
                                          "align-items": "center",
                                          gap: "10px",
                                          padding: "2px 16px",
                                          "font-family": FONT_SANS,
                                          "font-size": "12px",
                                          "font-weight": "var(--font-weight-regular)",
                                          color: "var(--color-text-muted)",
                                        }}
                                      >
                                        <div style={{ flex: 1, height: "1px", background: "var(--color-border)" }} />
                                        <span>Context compacted</span>
                                        <div style={{ flex: 1, height: "1px", background: "var(--color-border)" }} />
                                      </div>
                                    }
                                  >
                                    <div
                                      style={{
                                        display: "flex",
                                        "align-items": "center",
                                        "justify-content": "center",
                                        gap: "8px",
                                        padding: "6px 16px",
                                        "font-family": FONT_SANS,
                                        "font-size": "12px",
                                        "font-weight": "var(--font-weight-regular)",
                                        color: "var(--color-text-muted)",
                                      }}
                                    >
                                      <AsciiSpinner size={10} />
                                      <span>Compacting conversation…</span>
                                    </div>
                                  </Show>
                                }
                              >
                                <SessionTurn
                                  sessionID={params.id!}
                                  messageID={message.id}
                                  lastUserMessageID={lastUserMessage()?.id}
                                  stepsExpanded={stepsExpanded()[message.id] ?? false}
                                  onStepsExpandedToggle={() => toggleSteps(message.id)}
                                  classes={{
                                    root: "min-w-0 w-full relative",
                                    content: "flex flex-col justify-between !overflow-visible",
                                    container: "w-full px-4 md:px-5",
                                  }}
                                />
                              </Show>
                              {/* The v1.1.116 between-turns rule — skipped for a
                                  compaction row, which already draws its own "context
                                  compacted" divider (avoids a doubled rule). */}
                              <Show when={index() < turnMessages().length - 1 && !hasCompactionPart(message.id)}>
                                <div class="session-turn-divider" />
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>

                    <div class="session-jump-latest-rail" aria-live="polite">
                      <Show when={chatScroll.userScrolled()}>
                        <button
                          type="button"
                          class="session-jump-latest"
                          onClick={() => chatScroll.forceScrollToBottom()}
                          title="Jump to Latest"
                        >
                          <IconChevronDown size={13} strokeWidth={1.6} />
                          Jump to Latest
                        </button>
                      </Show>
                    </div>
                  </div>
                </Match>
                <Match when={true}>
                  <div aria-hidden="true" style={{ flex: 1, "min-height": 0 }} />
                </Match>
              </Switch>

              <div ref={(element) => (promptDockElement = element)} class="session-prompt-dock">
                <div class="session-prompt-dock__inner">
                  <Show when={revertInfo()}>
                    <div
                      class="mb-3"
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "12px",
                        padding: "8px 12px",
                        border: "1px solid var(--color-border)",
                        "border-radius": "8px",
                        "font-size": "12px",
                        "font-family": FONT_SANS,
                        color: "var(--color-text-muted)",
                        background: "var(--color-bg)",
                      }}
                    >
                      <span style={{ flex: 1, "min-width": 0 }}>
                        Conversation reverted. {revertedCount()} turn{revertedCount() === 1 ? "" : "s"} hidden and file
                        changes rolled back. Sending a new message makes this permanent.
                      </span>
                      <button
                        type="button"
                        onClick={() => void restoreRevert()}
                        style={{
                          border: "1px solid var(--color-border)",
                          background: "transparent",
                          color: "inherit",
                          padding: "4px 10px",
                          "border-radius": "8px",
                          "font-size": "12px",
                          "font-weight": "var(--font-weight-regular)",
                          cursor: "pointer",
                          "white-space": "nowrap",
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  </Show>
                  <PromptInput />
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

function Header(props: {
  title: string
  tabs: SessionTabItem[]
  active: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (id: string, to: number) => void
  onRename: (id: string, title: string) => Promise<boolean>
  onWarm: (id: string) => void
  onBack: () => void
  onToggleSessions: () => void
}): JSX.Element {
  return (
    <AppHeader class="workspace-header">
      <button
        type="button"
        class="session-sidebar-toggle workspace-header__sessions"
        onClick={props.onToggleSessions}
        title="Show sessions"
        aria-label="Show sessions"
      >
        <IconMessageSquare size={13} strokeWidth={1.5} />
      </button>
      <button
        class="workspace-header__back"
        onClick={props.onBack}
        title="Back to projects"
        aria-label="Back to projects"
      >
        <IconChevronLeft size={14} strokeWidth={1.6} />
      </button>
      <h1 class="sr-only">{props.title}</h1>
      <SessionTabStrip
        tabs={props.tabs}
        active={props.active}
        onSelect={props.onSelect}
        onClose={props.onClose}
        onReorder={props.onReorder}
        onRename={props.onRename}
        onWarm={props.onWarm}
      />
    </AppHeader>
  )
}

function SessionsSidebar(props: {
  projectName: string
  sessions: SyncSession[]
  activeId: string | undefined
  dirParam: string
  creating: boolean
  collapsed: boolean
  width: number
  mobileOpen: boolean
  onCloseMobile: () => void
  onNew: () => void
  onBack: () => void
  onCollapse: () => void
  onResize: (width: number, done: boolean) => void
  onSearch: () => void
  onCustomize: () => void
  onContext: (context: SessionContext) => void
  context: SessionContext
  contextOpen: boolean
  artifact: boolean
  onSelect: (id: string) => void
  onWarm: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onPin: (id: string, pinned: boolean) => void
}): JSX.Element {
  const compact = createMediaQuery("(max-width: 719px)")
  const mobileHidden = () => compact() && !props.mobileOpen
  let sidebar: HTMLElement | undefined

  createEffect(() => {
    if (!compact() || !props.mobileOpen || !sidebar) return
    const previous = document.activeElement as HTMLElement | null
    const selector =
      'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"]), [role="button"]'
    queueMicrotask(() => sidebar?.querySelector<HTMLElement>(selector)?.focus())

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        props.onCloseMobile()
        return
      }
      if (event.key !== "Tab" || !sidebar) return
      const items = Array.from(sidebar.querySelectorAll<HTMLElement>(selector)).filter(
        (item) => !item.hasAttribute("disabled") && item.getClientRects().length > 0,
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown, true)
      if (previous?.isConnected) previous.focus()
    })
  })

  const resize = (event: PointerEvent) => {
    if (props.collapsed) return
    event.preventDefault()
    const origin = event.clientX
    const width = props.width
    const controller = new AbortController()
    const move = (next: PointerEvent) => props.onResize(width + next.clientX - origin, false)
    const stop = (next: PointerEvent) => {
      props.onResize(width + next.clientX - origin, true)
      controller.abort()
    }
    window.addEventListener("pointermove", move, { signal: controller.signal })
    window.addEventListener("pointerup", stop, { once: true, signal: controller.signal })
    window.addEventListener("pointercancel", stop, { once: true, signal: controller.signal })
  }

  return (
    <aside
      ref={sidebar}
      id="session-sidebar"
      class="atlas-scroll session-sidebar"
      data-mobile-open={props.mobileOpen ? "true" : "false"}
      data-collapsed={props.collapsed ? "true" : "false"}
      aria-label="Research sessions"
      aria-hidden={mobileHidden() ? "true" : undefined}
      aria-modal={compact() && props.mobileOpen ? "true" : undefined}
      role={compact() && props.mobileOpen ? "dialog" : undefined}
      inert={mobileHidden()}
      style={{
        "--session-sidebar-width": `${props.width}px`,
        "--session-sidebar-collapsed-width": `${SIDEBAR_WIDTH.collapsed}px`,
      }}
    >
      <div class="session-sidebar__top">
        <button
          type="button"
          class="session-sidebar__project"
          aria-label="Back to projects"
          data-tooltip="Projects"
          onClick={props.onBack}
        >
          <IconHome size={15} strokeWidth={1.5} />
          <strong>{props.projectName}</strong>
        </button>
        <button
          type="button"
          class="session-sidebar__collapse"
          aria-label={
            compact() ? "Close sessions" : props.collapsed ? "Expand sessions sidebar" : "Collapse sessions sidebar"
          }
          aria-controls="session-sidebar"
          aria-expanded={compact() ? props.mobileOpen : !props.collapsed}
          data-tooltip={compact() ? "Close sessions" : props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => (compact() ? props.onCloseMobile() : props.onCollapse())}
        >
          <Show
            when={compact()}
            fallback={
              <Show when={props.collapsed} fallback={<IconChevronLeft size={14} strokeWidth={1.6} />}>
                <IconChevronRight size={14} strokeWidth={1.6} />
              </Show>
            }
          >
            <IconX size={14} strokeWidth={1.6} />
          </Show>
        </button>
      </div>

      <nav class="session-sidebar__actions" aria-label="Research navigation">
        <div class="session-sidebar__action-list session-sidebar__primary-actions">
          <SidebarAction
            class="session-sidebar__new"
            label={props.creating ? "Creating…" : "New"}
            detail="Start a session"
            ariaLabel="New research"
            shortcut="⌘N"
            disabled={props.creating}
            onClick={props.onNew}
          >
            <IconPlus size={15} strokeWidth={1.7} />
          </SidebarAction>
          <SidebarAction
            label="Search"
            detail="Files, messages, and actions"
            ariaLabel="Search this project"
            shortcut="⌘K"
            onClick={props.onSearch}
          >
            <IconSearch size={15} strokeWidth={1.5} />
          </SidebarAction>
          <SidebarAction
            label="Customize"
            detail="Open settings"
            ariaLabel="Customize OpenScience"
            onClick={props.onCustomize}
          >
            <IconSettings size={15} strokeWidth={1.5} />
          </SidebarAction>
          <ProjectTrustControl />
        </div>

        <SessionSidebarActions
          context={props.context}
          contextOpen={props.contextOpen}
          artifact={props.artifact}
          onContext={props.onContext}
        />
      </nav>

      <Show when={!props.collapsed && !compact()}>
        <div
          class="session-sidebar__resize"
          role="separator"
          aria-label="Resize sessions sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_WIDTH.min}
          aria-valuemax={SIDEBAR_WIDTH.max}
          aria-valuenow={props.width}
          tabindex={0}
          onPointerDown={resize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            props.onResize(props.width + (event.key === "ArrowRight" ? 16 : -16), true)
          }}
        />
      </Show>

      <div class="session-sidebar__label" id="session-sidebar-sessions">
        Sessions
      </div>

      <nav class="session-sidebar__list" aria-labelledby="session-sidebar-sessions">
        <For each={props.sessions}>
          {(s) => (
            <SessionRow
              session={s}
              active={props.activeId === s.id}
              onSelect={() => props.onSelect(s.id)}
              onWarm={() => props.onWarm(s.id)}
              onDelete={() => props.onDelete(s.id)}
              onRename={(title) => props.onRename(s.id, title)}
              onPin={(pinned) => props.onPin(s.id, pinned)}
            />
          )}
        </For>
        <Show when={props.sessions.length === 0}>
          <div class="session-sidebar__empty">No sessions yet.</div>
        </Show>
      </nav>
    </aside>
  )
}

function ProjectTrustControl(): JSX.Element {
  const authority = useExecutionAuthority("shell")
  const dialog = useDialog()

  const trust = async () => {
    const root = authority.decision()?.remediation?.body.root
    if (!root || authority.trusting()) return
    const confirmed = await confirmDialog(dialog, {
      title: "Trust this project?",
      message: `Allow project code under ${root} to run using the current execution policy. If sandboxing is off or unavailable and fallback permits it, code may run with your user authority. Review Settings → Sandbox first.`,
      confirmLabel: "Trust project",
    })
    if (!confirmed) return
    try {
      await authority.trust()
      toast.success("Project trusted", "Project code can now run under the current execution policy.")
    } catch (error) {
      toast.error("Could not trust project", error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Show when={authority.canTrust()}>
      <SidebarAction
        class="session-sidebar__trust"
        label={authority.trusting() ? "Trusting…" : "Trust project"}
        detail="Allow project code"
        ariaLabel="Trust this project to run project code"
        disabled={authority.trusting()}
        onClick={() => void trust()}
      >
        <IconShield size={15} strokeWidth={1.5} />
      </SidebarAction>
    </Show>
  )
}

function SessionRow(props: {
  session: SyncSession
  active: boolean
  onSelect: () => void
  onWarm: () => void
  onDelete: () => void
  onRename: (title: string) => void
  onPin: (pinned: boolean) => void
}): JSX.Element {
  const [hover, setHover] = createSignal(false)
  const [menu, setMenu] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  let tab: HTMLButtonElement | undefined
  const startEdit = () => {
    setDraft(props.session.title || "")
    setEditing(true)
  }
  const finishEditing = (restoreFocus: boolean) => {
    setEditing(false)
    if (restoreFocus) queueMicrotask(() => tab?.focus())
  }
  const commit = (restoreFocus = false) => {
    if (!editing()) return
    const next = draft().trim()
    finishEditing(restoreFocus)
    if (next && next !== (props.session.title || "")) props.onRename(next)
  }
  const cancel = (restoreFocus = false) => {
    finishEditing(restoreFocus)
    setDraft("")
  }
  return (
    <div
      class="session-sidebar__session"
      role="presentation"
      data-active={props.active ? "true" : undefined}
      data-pinned={props.session.time?.pinned ? "true" : undefined}
      data-actions={(hover() || menu()) && !editing() ? "true" : undefined}
      data-menu-open={menu() ? "true" : undefined}
      data-editing={editing() ? "true" : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusIn={() => setHover(true)}
      onFocusOut={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setHover(false)
      }}
    >
      <Show
        when={editing()}
        fallback={
          <button
            ref={tab}
            type="button"
            class="session-sidebar__session-main"
            aria-current={props.active ? "page" : undefined}
            aria-label={props.session.title || "Session"}
            data-session-id={props.session.id}
            onPointerEnter={props.onWarm}
            onFocus={props.onWarm}
            onClick={props.onSelect}
            onDblClick={(event) => {
              event.preventDefault()
              startEdit()
            }}
          >
            <span class="session-sidebar__session-status" aria-hidden="true">
              <Show
                when={props.session.time?.pinned}
                fallback={
                  <span class="session-sidebar__session-dot">
                    <StatusDot status={props.active ? "active" : "muted"} size={7} />
                  </span>
                }
              >
                <IconPinFilled size={10} strokeWidth={1.4} />
              </Show>
            </span>
            <span class="session-sidebar__session-title" title="Double-click to rename">
              {props.session.title || "Session"}
            </span>
          </button>
        }
      >
        <input
          ref={(el) =>
            queueMicrotask(() => {
              el.focus()
              el.select()
            })
          }
          class="session-sidebar__session-input"
          aria-label="Rename session"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit(true)
            } else if (e.key === "Escape") {
              e.preventDefault()
              cancel(true)
            }
          }}
          onBlur={() => commit()}
          spellcheck={false}
          autocomplete="off"
        />
      </Show>
      <Show when={!editing()}>
        <DropdownMenu open={menu()} onOpenChange={setMenu}>
          <DropdownMenu.Trigger
            class="session-sidebar__session-menu-button"
            title="Session actions"
            aria-label={`Session actions for ${props.session.title || "Session"}`}
            tabindex={props.active || hover() || menu() ? 0 : -1}
          >
            <IconMoreH size={12} strokeWidth={1.5} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="session-sidebar__session-menu-popover">
              <DropdownMenu.Item onSelect={() => props.onPin(!props.session.time?.pinned)}>
                <Show when={props.session.time?.pinned} fallback={<IconPin size={12} strokeWidth={1.5} />}>
                  <IconPinFilled size={12} strokeWidth={1.5} />
                </Show>
                <DropdownMenu.ItemLabel>{props.session.time?.pinned ? "Unpin" : "Pin"}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={startEdit}>
                <DropdownMenu.ItemLabel>Rename</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="session-sidebar__session-menu-danger" onSelect={props.onDelete}>
                <IconTrash size={12} strokeWidth={1.5} />
                <DropdownMenu.ItemLabel>Delete</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </Show>
    </div>
  )
}
