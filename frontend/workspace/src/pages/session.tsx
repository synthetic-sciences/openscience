import {
  createComputed,
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
import { NewSessionView } from "@/components/session/session-new-view"
import { AsciiSpinner } from "@/atlas/shared/AsciiSpinner"
import { AppHeader, HeaderIconButton } from "@/atlas/AppHeader"
import { RightPane } from "@/atlas/RightPane"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { uiStore } from "@/atlas/store/ui"
import { useGlobalKeys } from "@/atlas/useGlobalKeys"
import { useDialog } from "@synsci/ui/context/dialog"
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
  IconPlus,
  IconSearch,
  IconCheckCircle,
  IconSettings,
  IconMessageSquare,
  IconMoreH,
  IconPin,
  IconPinFilled,
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

type SyncSession = ReturnType<typeof useSync>["data"]["session"][number]

/**
 * Session page — new visual identity (Synthetic Sciences wordmark + sessions
 * sidebar + conversation workspace + contextual files and research pane) wrapping
 * the unchanged openscience backend chat (SessionTurn rendering, PromptInput,
 * real SSE streaming, sub-task delegation, tool calls, TODOs, diff cards).
 */
const sessionSidebarKey = "openscience-session-sidebar-v1"
const sessionSidebarWidthKey = "openscience-session-sidebar-width-v1"

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

  createEffect(
    on(
      () => server.url,
      (url) => {
        productPreferences.sync({ show_trace: false, atlas_enabled: false })
        if (!url) return
        const endpoint = `${url.replace(/\/$/, "")}/settings/preferences`
        void (platform.fetch ?? fetch)(endpoint)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Preferences unavailable"))))
          .then((preferences) => productPreferences.sync(preferences as ProductPreferences))
          .catch(() => productPreferences.sync({ show_trace: false, atlas_enabled: false }))
      },
    ),
  )

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

  const atlasAvailable = () => productPreferences.atlas()

  createEffect(() => {
    if (productPreferences.atlas()) return
    if (uiStore.context() !== "canvas" || !uiStore.open()) return
    uiStore.closeContext()
  })

  const openContext = (context: SessionContext) => {
    if (context === "canvas" && !atlasAvailable()) return
    uiStore.openContext(context)
    if (context !== "terminal") return
    void ensureSession()
  }

  async function deleteSession(sessionID: string) {
    const ok = await confirmDialog(dialog, {
      title: "Delete this session?",
      message: "This removes the conversation and its session-owned workspace. Saved artifacts stay available.",
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
      toast.info("Session deleted")
      if (active) {
        navigate(next ? `/${params.dir}/session/${next}` : `/${params.dir}/session/new`)
      }
    } catch (error: unknown) {
      console.error("session.delete failed", error)
      toast.error("Could not delete session", error instanceof Error ? error.message : String(error))
    }
  }

  async function renameSession(sessionID: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      await sync.session.rename(sessionID, trimmed)
    } catch (error: unknown) {
      console.error("session.rename failed", error)
      toast.error("Could not rename session", error instanceof Error ? error.message : String(error))
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
            await sync.session.sync(id)
          } catch {}
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

  createComputed(
    on(
      () => [sdk.scope, params.id] as const,
      ([project, id]) => {
        sessionTabs.activateProject(project)
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

  const openSessions = createMemo(() =>
    sessionTabs.tabs().map((id) => {
      const session = sessions().find((item) => item.id === id)
      const updated = session?.time?.updated ?? 0
      return {
        id,
        title: session?.title || "session",
        working: Boolean(sync.data.session_status?.[id] && sync.data.session_status[id].type !== "idle"),
        dirty: sessionTabs.dirty(id),
        unread: sessionTabs.unread(id, updated),
      }
    }),
  )

  const closeSessionTab = (id: string) => {
    const next = sessionTabs.close(id)
    if (params.id !== id) return
    navigate(next ? `/${params.dir}/session/${next}` : `/${params.dir}/session/new`)
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
    const onReview = () => void runReview()
    document.addEventListener("openscience:open-context", onOpenContext)
    document.addEventListener("openscience:run-review", onReview)
    onCleanup(() => {
      document.removeEventListener("openscience:open-file", onOpenFile)
      document.removeEventListener("openscience:open-context", onOpenContext)
      document.removeEventListener("openscience:run-review", onReview)
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
      toast.success("reverted", "files rolled back. send a message to continue from here")
    } catch (e: any) {
      toast.error("undo failed", e?.message ?? String(e))
    }
  }

  const restoreRevert = async () => {
    const id = params.id
    if (!id) return
    try {
      await sync.session.unrevert(id)
      toast.success("messages restored")
    } catch (e: any) {
      toast.error("restore failed", e?.message ?? String(e))
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
            toast.error("could not start terminal", cause instanceof Error ? cause.message : String(cause))
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
    // /compact — summarize the conversation to free up context. Runs the backend
    // compaction action (model/agent default to the session's last); it does NOT
    // prefill text, so it must be a builtin option, not a `sync.data.command`
    // entry (those prefill). The backend command is deduped out of the prompt
    // menu's custom list by its `menu` flag.
    list.push({
      id: "session.compact",
      title: "Compact conversation",
      description: "Summarize the conversation so far to free up context",
      category: language.t("command.category.session"),
      slash: "compact",
      onSelect: () => {
        void sdk.client.session
          .command({ sessionID: id, command: "compact", arguments: "" } as any)
          .catch((e: unknown) => {
            console.error("compact failed", e)
            toast.error("could not compact", e instanceof Error ? e.message : String(e))
          })
      },
    })
    // /handoff — write a self-contained handoff.md for another agent, then compact.
    list.push({
      id: "session.handoff",
      title: "Write handoff & compact",
      description: "Write a self-contained handoff.md for another agent, then compact",
      category: language.t("command.category.session"),
      slash: "handoff",
      onSelect: () => {
        void sdk.client.session
          .command({ sessionID: id, command: "handoff", arguments: "" } as any)
          .catch((e: unknown) => {
            console.error("handoff failed", e)
            toast.error("could not write handoff", e instanceof Error ? e.message : String(e))
          })
      },
    })
    return list
  })

  const [stepsExpanded, setStepsExpanded] = createSignal<Record<string, boolean>>({})
  const toggleSteps = (id: string) => setStepsExpanded((prev) => ({ ...prev, [id]: !prev[id] }))

  useGlobalKeys({ onNew: newSession })

  // The center belongs to the conversation for the lifetime of the route.
  // Files and other research surfaces mount only in the right context pane.
  const chatTitle = createMemo(() => {
    const s = sessions().find((x) => x.id === params.id)
    return s?.title || "New session"
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

  // The reviewer is a direct action, never a chat prompt: POST /session/:id/review
  // launches the reviewer pass on the open session (project-scoped like every
  // other request) and its findings stream into the session as a turn.
  const reviewDisabled = createMemo(() => !params.id || params.id === "new" || working())
  const runReview = async () => {
    const id = params.id
    if (!id || id === "new" || working()) return
    const response = await sdk.request(`/session/${id}/review`, { method: "POST" }).catch(() => undefined)
    if (!response?.ok) {
      toast.error("review failed", response ? `${response.status}` : "request failed")
      return
    }
    toast.success("review started", "the reviewer streams into this session")
  }

  const chatScroll = createAutoScroll({
    working,
    overflowAnchor: "dynamic",
    bottomThreshold: 120,
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
    onCleanup(() => observer?.disconnect())
  })

  return (
    <div
      class="atlas-root"
      style={{
        flex: 1,
        display: "flex",
        "flex-direction": "column",
        height: "100dvh",
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
            aria-label="close sessions"
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
          atlas={atlasAvailable()}
          trace={productPreferences.trace()}
          onSelect={(id) => {
            setMobileSessionsOpen(false)
            sessionTabs.open(id)
            navigate(`/${params.dir}/session/${id}`)
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
            onBack={() => navigate("/")}
            onRunReview={() => void runReview()}
            reviewDisabled={reviewDisabled()}
            onToggleSessions={() => setMobileSessionsOpen((open) => !open)}
          />
          <SessionTabStrip
            tabs={openSessions()}
            active={params.id}
            onSelect={(id) => {
              sessionTabs.open(id)
              navigate(`/${params.dir}/session/${id}`)
            }}
            onClose={closeSessionTab}
            onReorder={(id, to) => sessionTabs.move(id, to)}
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
                      {/* Sub-agent back-to-parent header only. Normal chats render
                          NO fixed header — the sticky session title used to sit on top
                          of the conversation and block content. The title is still
                          shown/renamable in the session list. Kept outside contentRef
                          so the ResizeObserver measures only the growing message list. */}
                      <Show when={activeSession()?.parentID}>
                        <div class="sticky top-0 z-30 bg-background-stronger w-full">
                          <div class="w-full px-4 md:px-6 md:max-w-200 md:mx-auto">
                            <div class="h-10 flex items-center gap-1.5">
                              <Show when={activeSession()?.parentID}>
                                <button
                                  type="button"
                                  class="flex items-center justify-center size-7 shrink-0 rounded-md text-text-weak hover:text-text-base hover:bg-surface-base-hover transition-colors"
                                  aria-label="Back to parent session"
                                  onClick={() => navigate(`/${params.dir}/session/${activeSession()!.parentID}`)}
                                >
                                  <IconChevronLeft />
                                </button>
                              </Show>
                              <Show when={activeSession()?.title}>
                                <EditableTitle
                                  title={activeSession()!.title!}
                                  onRename={(t) => void renameSession(activeSession()!.id, t)}
                                />
                              </Show>
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
                        style={{ "padding-bottom": "var(--workspace-composer-reserve)" }}
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
                                          "font-size": "11px",
                                          "letter-spacing": "0.06em",
                                          "text-transform": "uppercase",
                                          color: "var(--color-text-faint)",
                                        }}
                                      >
                                        <div style={{ flex: 1, height: "1px", background: "var(--color-border)" }} />
                                        <span>context compacted</span>
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
                                        "font-family": FONT_MONO,
                                        "font-size": "11px",
                                        "letter-spacing": "0.06em",
                                        "text-transform": "uppercase",
                                        color: "var(--color-text-faint)",
                                      }}
                                    >
                                      <AsciiSpinner size={10} />
                                      <span>compacting conversation…</span>
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

                    <Show when={chatScroll.userScrolled()}>
                      <button
                        type="button"
                        onClick={() => chatScroll.forceScrollToBottom()}
                        title="Jump to latest"
                        style={{
                          position: "absolute",
                          // Share the dock reserve with the transcript so composer
                          // geometry can change without hiding the final turn.
                          bottom: "calc(var(--workspace-composer-reserve) + 16px)",
                          left: "50%",
                          transform: "translateX(-50%)",
                          display: "inline-flex",
                          "align-items": "center",
                          gap: "6px",
                          padding: "6px 12px",
                          "border-radius": "999px",
                          border: "1px solid var(--color-border-strong)",
                          background: "var(--color-surface-solid)",
                          "box-shadow": "var(--shadow-md)",
                          "font-family": FONT_MONO,
                          "font-size": "11px",
                          color: "var(--color-text)",
                          cursor: "pointer",
                          "z-index": 6,
                        }}
                      >
                        <IconChevronDown size={13} strokeWidth={1.6} />
                        jump to latest
                      </button>
                    </Show>
                  </div>
                </Match>
                <Match when={true}>
                  <NewSessionView />
                </Match>
              </Switch>

              <div class="session-prompt-dock">
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
                          cursor: "pointer",
                          "white-space": "nowrap",
                        }}
                      >
                        restore
                      </button>
                    </div>
                  </Show>
                  <PromptInput />
                </div>
              </div>
            </section>
          </div>
        </div>

        <RightPane project={sdk.scope} session={params.id ?? "new"} onEnsureSession={ensureSession} />
      </div>
    </div>
  )
}

const TAB_DRAG_TYPE = "text/openscience-session-tab"

function SessionTabStrip(props: {
  tabs: Array<{ id: string; title: string; working: boolean; dirty: boolean; unread: boolean }>
  active: string | undefined
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (id: string, to: number) => void
}): JSX.Element {
  const compact = createMediaQuery("(max-width: 719px)")
  const limit = createMemo(() => (compact() ? 2 : 5))
  const visible = createMemo(() => {
    if (props.tabs.length <= limit()) return props.tabs
    const first = props.tabs.slice(0, limit())
    const active = props.tabs.find((tab) => tab.id === props.active)
    if (!active || first.some((tab) => tab.id === active.id)) return first
    return [...first.slice(0, -1), active]
  })
  const hidden = createMemo(() => {
    const shown = new Set(visible().map((tab) => tab.id))
    return props.tabs.filter((tab) => !shown.has(tab.id))
  })
  const tab = (item: (typeof props.tabs)[number], index: number) => (
    <div
      class="workspace-tab"
      role="tab"
      tabindex={0}
      aria-selected={props.active === item.id}
      aria-label={`${item.title}${item.working ? ", working" : item.unread ? ", unread" : ""}${item.dirty ? ", draft saved" : ""}`}
      data-active={props.active === item.id ? "true" : undefined}
      draggable="true"
      onDragStart={(event) => {
        event.dataTransfer?.setData(TAB_DRAG_TYPE, item.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) event.preventDefault()
      }}
      onDrop={(event) => {
        const dragged = event.dataTransfer?.getData(TAB_DRAG_TYPE)
        if (!dragged || dragged === item.id) return
        event.preventDefault()
        props.onReorder(dragged, index)
      }}
      onClick={() => props.onSelect(item.id)}
      onKeyDown={(event) => {
        if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault()
          props.onReorder(item.id, index + (event.key === "ArrowRight" ? 1 : -1))
          return
        }
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        props.onSelect(item.id)
      }}
    >
      <span class="workspace-tab__icon" aria-hidden="true">
        <StatusDot status={item.working ? "active" : item.unread ? "pending" : "muted"} size={6} />
      </span>
      <span class="truncate">{item.title}</span>
      <Show when={item.dirty}>
        <span aria-label="Draft saved" title="Draft saved">
          •
        </span>
      </Show>
      <button
        type="button"
        class="workspace-tab__close"
        aria-label={`Close ${item.title} tab`}
        onClick={(event) => {
          event.stopPropagation()
          props.onClose(item.id)
        }}
      >
        <IconX size={11} strokeWidth={1.5} />
      </button>
    </div>
  )

  return (
    <Show when={props.tabs.length > 0}>
      <nav class="workspace-tabs" aria-label="Open session tabs">
        <div class="workspace-tabs__list" role="tablist">
          <For each={visible()}>
            {(item) =>
              tab(
                item,
                props.tabs.findIndex((entry) => entry.id === item.id),
              )
            }
          </For>
        </div>
        <Show when={hidden().length > 0}>
          <details class="workspace-tabs__overflow">
            <summary aria-label={`${hidden().length} more session tabs`}>
              <IconMoreH size={14} strokeWidth={1.5} />
              <span>{hidden().length}</span>
            </summary>
            <div role="menu">
              <For each={hidden()}>
                {(item) => (
                  <button
                    type="button"
                    role="menuitem"
                    aria-current={props.active === item.id ? "page" : undefined}
                    onClick={(event) => {
                      props.onSelect(item.id)
                      event.currentTarget.closest("details")?.removeAttribute("open")
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
                      event.preventDefault()
                      const index = props.tabs.findIndex((entry) => entry.id === item.id)
                      props.onReorder(item.id, index + (event.key === "ArrowRight" ? 1 : -1))
                    }}
                  >
                    <StatusDot status={item.working ? "active" : item.unread ? "pending" : "muted"} size={6} />
                    <span>{item.title}</span>
                    <Show when={item.dirty}>•</Show>
                  </button>
                )}
              </For>
            </div>
          </details>
        </Show>
      </nav>
    </Show>
  )
}

function Header(props: {
  title: string
  onBack: () => void
  onRunReview: () => void
  reviewDisabled: boolean
  onToggleSessions: () => void
}): JSX.Element {
  return (
    <AppHeader class="workspace-header">
      <HeaderIconButton class="session-sidebar-toggle" onClick={props.onToggleSessions} title="Show sessions">
        <IconMessageSquare size={13} strokeWidth={1.5} />
      </HeaderIconButton>
      <button
        class="workspace-header__back"
        onClick={props.onBack}
        title="Back to projects"
        aria-label="Back to projects"
      >
        <IconChevronLeft size={14} strokeWidth={1.6} />
      </button>
      <div class="workspace-header__project" title={props.title}>
        <span class="workspace-header__title">
          <strong>{props.title}</strong>
        </span>
      </div>
      <span class="workspace-header__spacer" />
      <HeaderIconButton
        class="workspace-header__review"
        disabled={props.reviewDisabled}
        onClick={props.onRunReview}
        title={props.reviewDisabled ? "Open an idle session to run review" : "Run review"}
      >
        <IconCheckCircle size={14} strokeWidth={1.5} />
      </HeaderIconButton>
    </AppHeader>
  )
}

// The conversation title in the sticky chat header — double-click to rename,
// mirroring the sidebar's SessionRow. Enter/blur commits, Esc cancels.
function EditableTitle(props: { title: string; onRename: (t: string) => void }): JSX.Element {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const start = () => {
    setDraft(props.title)
    setEditing(true)
  }
  const commit = () => {
    if (!editing()) return
    const next = draft().trim()
    setEditing(false)
    if (next && next !== props.title) props.onRename(next)
  }
  return (
    <Show
      when={editing()}
      fallback={
        <h1
          class="text-14-medium text-text-strong truncate"
          style={{ cursor: "text" }}
          title="Double-click to rename"
          onDblClick={start}
        >
          {props.title}
        </h1>
      }
    >
      <input
        ref={(el) =>
          queueMicrotask(() => {
            el.focus()
            el.select()
          })
        }
        class="text-14-medium text-text-strong truncate"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setEditing(false)
          }
        }}
        onBlur={commit}
        spellcheck={false}
        autocomplete="off"
        style={{
          all: "unset",
          "box-sizing": "border-box",
          flex: 1,
          "min-width": 0,
          "font-family": FONT_SANS,
          background: "var(--color-surface-solid)",
          "box-shadow": "inset 0 0 0 1px var(--color-border-strong)",
          "border-radius": "6px",
          padding: "1px 6px",
          margin: "0 -6px",
          color: "var(--color-text-strong, var(--color-text))",
        }}
      />
    </Show>
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
  atlas: boolean
  trace: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onPin: (id: string, pinned: boolean) => void
}): JSX.Element {
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
      class="atlas-scroll session-sidebar"
      data-mobile-open={props.mobileOpen ? "true" : "false"}
      data-collapsed={props.collapsed ? "true" : "false"}
      aria-label="Research sessions"
      style={{ "--session-sidebar-width": `${props.width}px` }}
    >
      <div class="session-sidebar__top">
        <button type="button" class="session-sidebar__project" aria-label="Back to projects" onClick={props.onBack}>
          <IconChevronLeft size={13} strokeWidth={1.6} />
          <strong>{props.projectName}</strong>
        </button>
        <button
          type="button"
          class="session-sidebar__collapse"
          aria-label={props.collapsed ? "Expand sessions sidebar" : "Collapse sessions sidebar"}
          title={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={props.onCollapse}
        >
          <IconChevronLeft size={13} strokeWidth={1.6} />
        </button>
      </div>

      <nav class="session-sidebar__actions" aria-label="Research navigation">
        <div class="session-sidebar__action-list">
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
            detail="Search and commands"
            ariaLabel="Search project"
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
        </div>

        <SessionSidebarActions
          context={props.context}
          contextOpen={props.contextOpen}
          artifact={props.artifact}
          atlas={props.atlas}
          trace={props.trace}
          onContext={props.onContext}
        />
      </nav>

      <Show when={!props.collapsed}>
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

      <div class="session-sidebar__label">
        <span>Recent sessions</span>
        <span>{props.sessions.length}</span>
      </div>

      <div class="session-sidebar__list">
        <For each={props.sessions}>
          {(s) => (
            <SessionRow
              session={s}
              active={props.activeId === s.id}
              onSelect={() => props.onSelect(s.id)}
              onDelete={() => props.onDelete(s.id)}
              onRename={(title) => props.onRename(s.id, title)}
              onPin={(pinned) => props.onPin(s.id, pinned)}
            />
          )}
        </For>
        <Show when={props.sessions.length === 0}>
          <div class="session-sidebar__empty">No sessions yet.</div>
        </Show>
      </div>
    </aside>
  )
}

function SessionRow(props: {
  session: SyncSession
  active: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (title: string) => void
  onPin: (pinned: boolean) => void
}): JSX.Element {
  const [hover, setHover] = createSignal(false)
  const [menu, setMenu] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const startEdit = () => {
    setDraft(props.session.title || "")
    setEditing(true)
  }
  const commit = () => {
    if (!editing()) return
    const next = draft().trim()
    setEditing(false)
    if (next && next !== (props.session.title || "")) props.onRename(next)
  }
  const cancel = () => {
    setEditing(false)
    setDraft("")
  }
  return (
    <div
      class="session-sidebar__session"
      role="button"
      tabindex="0"
      aria-label={props.session.title || "session"}
      data-active={props.active ? "true" : undefined}
      data-pinned={props.session.time?.pinned ? "true" : undefined}
      data-actions={hover() && !editing() ? "true" : undefined}
      onClick={() => {
        if (editing()) return
        props.onSelect()
      }}
      onDblClick={(e) => {
        e.stopPropagation()
        startEdit()
      }}
      onKeyDown={(e) => {
        if (editing()) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          props.onSelect()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusIn={() => setHover(true)}
      onFocusOut={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setHover(false)
        setMenu(false)
      }}
      style={{ cursor: editing() ? "text" : "pointer" }}
    >
      <Show
        when={props.session.time?.pinned}
        fallback={<StatusDot status={props.active ? "active" : "muted"} size={7} />}
      >
        <IconPinFilled size={10} strokeWidth={1.4} />
      </Show>
      <Show
        when={editing()}
        fallback={
          <span class="session-sidebar__session-title" title="Double-click to rename">
            {props.session.title || "session"}
          </span>
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
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              cancel()
            }
          }}
          onBlur={commit}
          spellcheck={false}
          autocomplete="off"
        />
      </Show>
      <Show when={(hover() || menu()) && !editing()}>
        <button
          type="button"
          class="session-sidebar__session-menu-button"
          title="Session actions"
          aria-label="Session actions"
          aria-haspopup="menu"
          aria-expanded={menu()}
          onPointerDown={(e) => {
            // Stop pointerdown on the parent row before its own click
            // can fire — Solid runs the row's onClick first otherwise.
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setMenu((open) => !open)
          }}
        >
          <IconMoreH size={12} strokeWidth={1.5} />
        </button>
      </Show>
      <Show when={menu()}>
        <div class="session-sidebar__session-menu" role="menu" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onPin(!props.session.time?.pinned)
              setMenu(false)
            }}
          >
            <Show when={props.session.time?.pinned} fallback={<IconPin size={12} strokeWidth={1.5} />}>
              <IconPinFilled size={12} strokeWidth={1.5} />
            </Show>
            {props.session.time?.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false)
              startEdit()
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            data-danger="true"
            onClick={() => {
              setMenu(false)
              props.onDelete()
            }}
          >
            <IconTrash size={12} strokeWidth={1.5} />
            Delete
          </button>
        </div>
      </Show>
    </div>
  )
}
