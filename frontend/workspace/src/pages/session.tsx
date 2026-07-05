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
import { SessionTurn } from "@synsci/ui/session-turn"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { useTheme } from "@synsci/ui/theme"
import { Composer } from "@/thesis/Composer"
import { Wordmark } from "@/thesis/Wordmark"
import { AppHeader, HeaderIconButton, HeaderDivider } from "@/thesis/AppHeader"
import { RightPane } from "@/thesis/RightPane"
import { FileExplorer } from "@/thesis/FileExplorer"
import { FileView } from "@/thesis/FilePreview"
import { centerTabs } from "@/thesis/store/centerTabs"
import { FONT_MONO, FONT_SANS, FONT_SERIF, sectionTitle } from "@/styles/tokens"
import { uiStore } from "@/thesis/store/ui"
import { useGlobalKeys } from "@/thesis/useGlobalKeys"
import { useDialog } from "@synsci/ui/context/dialog"
import { confirmDialog } from "@/thesis/dialogs"
import { DialogSettings } from "@/components/dialog-settings"
import { DisconnectedPanel } from "@/thesis/DisconnectedPanel"
import { CommandPalette } from "@/thesis/CommandPalette"
import { HelpOverlay } from "@/thesis/HelpOverlay"
import { ToastContainer } from "@/thesis/Toast"
import {
  IconChevronLeft,
  IconPlus,
  IconSearch,
  IconBookOpen,
  IconSettings,
  IconSun,
  IconMoon,
  IconMessageSquare,
  IconFolderTree,
  IconFile,
  IconX,
} from "@/thesis/shared/Icon"
import { StatusDot } from "@/thesis/shared/StatusDot"
import { DateTime } from "luxon"
import { IconTrash } from "@/thesis/shared/Icon"
import { toast } from "@/thesis/Toast"

type SyncSession = ReturnType<typeof useSync>["data"]["session"][number]

/**
 * Session page — new visual identity (Synthetic Sciences wordmark + sessions
 * sidebar + chat + canvas/agents/skills/files right pane) wrapping the
 * unchanged openscience backend chat (SessionTurn rendering, PromptInput, real
 * SSE streaming, sub-task delegation, tool calls, TODOs, diff cards).
 */
export default function Page(): JSX.Element {
  const params = useParams()
  const navigate = useNavigate()
  const sync = useSync()
  const sdk = useSDK()
  const layout = useLayout()
  const theme = useTheme()
  const dialog = useDialog()
  const [creating, setCreating] = createSignal(false)

  async function newSession() {
    if (creating()) return
    setCreating(true)
    try {
      const res: any = await sdk.client.session.create({
        directory: sync.project?.worktree ?? sync.data.path.directory,
      } as any)
      const data = res?.data ?? res
      const id = data?.id ?? data?.sessionID
      if (id) {
        navigate(`/${params.dir}/session/${id}`)
      } else {
        navigate(`/${params.dir}/session/new`)
      }
    } catch {
      navigate(`/${params.dir}/session/new`)
    } finally {
      setCreating(false)
    }
  }

  async function deleteSession(sessionID: string) {
    // Capture the next-active id BEFORE the optimistic splice so we
    // know where to navigate.
    const active = params.id === sessionID
    const next = sessions().find((s) => s.id !== sessionID)?.id
    try {
      await sync.session.delete(sessionID)
      toast.info("session deleted")
      if (active) {
        navigate(next ? `/${params.dir}/session/${next}` : `/${params.dir}/session/new`)
      }
    } catch (e: any) {
      console.error("session.delete failed", e)
      toast.error("could not delete", e?.message ?? String(e))
    }
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
  // which right-pane tab is open, so the Agents view and inline turn status
  // populate immediately and survive a reload.
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
    const p = projectPath()
    const segs = p.split("/").filter(Boolean)
    return segs[segs.length - 1] ?? p
  }
  const projectPath = () => project()?.worktree ?? sdk.directory

  const sessions = createMemo<SyncSession[]>(() =>
    [...sync.data.session].filter((s) => !s.parentID).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
  )
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
  const turnMessages = createMemo(() => {
    const revertID = revertInfo()?.messageID
    return messages().filter((m) => m.role === "user" && (!revertID || m.id < revertID))
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
      confirmLabel: "undo",
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

  const [stepsExpanded, setStepsExpanded] = createSignal<Record<string, boolean>>({})
  const toggleSteps = (id: string) => setStepsExpanded((prev) => ({ ...prev, [id]: !prev[id] }))

  const isDark = () => theme.mode() === "dark"
  useGlobalKeys({ onNew: () => void newSession() })

  // Center-pane tabs. The chat tab is always mounted (so streaming + scroll
  // survive tab switches); Files mounts on first visit; document tabs mount
  // when opened from the explorer and unmount on close.
  const chatTitle = createMemo(() => {
    const s = sessions().find((x) => x.id === params.id)
    return s?.title || "Chat"
  })
  const [visitedFiles, setVisitedFiles] = createSignal(false)
  createEffect(() => {
    if (centerTabs.active() === "files") setVisitedFiles(true)
  })

  // Chat scroll. The container resizes whenever the right pane opens/closes
  // (the chat column narrows/widens) or the window changes size. A bare reflow
  // can drop the scroll position to the top, so we track whether the user is
  // pinned to the bottom and re-anchor on every resize via a ResizeObserver —
  // sticking to the bottom when they were reading the latest output, or
  // preserving their distance from the bottom when they had scrolled up.
  let scrollRef: HTMLDivElement | undefined
  let scrollObserver: ResizeObserver | undefined
  let boundScroll: HTMLDivElement | undefined
  const NEAR_BOTTOM_PX = 120
  let pinnedToBottom = true
  let distanceFromBottom = 0

  const recordScroll = () => {
    if (!scrollRef) return
    distanceFromBottom = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight
    pinnedToBottom = distanceFromBottom <= NEAR_BOTTOM_PX
  }

  const stickToBottom = () => {
    if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
  }

  const reanchor = () => {
    if (!scrollRef) return
    if (pinnedToBottom) stickToBottom()
    else scrollRef.scrollTop = Math.max(0, scrollRef.scrollHeight - scrollRef.clientHeight - distanceFromBottom)
  }

  const attachScroll = (el: HTMLDivElement) => {
    if (boundScroll === el) return
    if (scrollObserver) scrollObserver.disconnect()
    if (boundScroll) boundScroll.removeEventListener("scroll", recordScroll)
    boundScroll = el
    scrollRef = el
    pinnedToBottom = true
    el.addEventListener("scroll", recordScroll, { passive: true })
    // First callback fires synchronously on observe; ignore it (initial layout)
    // and only re-anchor on genuine resizes after that.
    let primed = false
    scrollObserver = new ResizeObserver(() => {
      if (!primed) {
        primed = true
        return
      }
      reanchor()
    })
    scrollObserver.observe(el)
  }

  onCleanup(() => {
    if (scrollObserver) scrollObserver.disconnect()
    if (boundScroll) boundScroll.removeEventListener("scroll", recordScroll)
  })

  // New messages / session switch → keep the latest output in view when the
  // user is pinned to the bottom (don't yank them down if they scrolled up).
  createEffect(
    on(
      () => [messages().length, params.id],
      ([, id], prev) => {
        const sessionChanged = !prev || prev[1] !== id
        if (sessionChanged) pinnedToBottom = true
        if (scrollRef && pinnedToBottom)
          requestAnimationFrame(() => {
            if (scrollRef && pinnedToBottom) stickToBottom()
          })
      },
    ),
  )

  createEffect(() => {
    if (project()) layout.projects.open(project()!.worktree)
  })

  return (
    <div
      class="thesis-root"
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
      <Header
        projectName={projectName()}
        projectPath={projectPath()}
        isDark={isDark()}
        onBack={() => navigate("/")}
        onOpenPalette={() => uiStore.setPaletteOpen(true)}
        onOpenHelp={() => uiStore.setHelpOpen(true)}
        onOpenSettings={() => dialog.show(() => <DialogSettings />)}
        onToggleTheme={() => theme.setColorScheme(isDark() ? "light" : "dark")}
      />

      <div
        style={{
          flex: 1,
          "min-height": 0,
          "min-width": 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        <SessionsSidebar
          sessions={sessions()}
          activeId={params.id}
          dirParam={params.dir ?? ""}
          creating={creating()}
          onNew={() => void newSession()}
          onSelect={(id) => navigate(`/${params.dir}/session/${id}`)}
          onDelete={(id) => void deleteSession(id)}
        />

        <div
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
          <CenterTabStrip chatTitle={chatTitle()} />

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
            {/* chat — always mounted so streaming + scroll survive tab switches */}
            <div
              style={{
                display: centerTabs.active() === "chat" ? "flex" : "none",
                flex: 1,
                "min-height": 0,
                "flex-direction": "column",
              }}
            >
              <Switch>
                <Match when={params.id && messages().length > 0}>
                  <div
                    ref={attachScroll}
                    class="thesis-scroll thesis-chat-scroll"
                    style={{
                      flex: 1,
                      "min-height": 0,
                      "overflow-y": "auto",
                      "overflow-x": "hidden",
                      "padding-top": "12px",
                    }}
                  >
                    <For each={turnMessages()}>
                      {(message, index) => (
                        <div
                          data-message-id={message.id}
                          style={{
                            "min-width": 0,
                            width: "100%",
                            "max-width": "100%",
                          }}
                        >
                          <SessionTurn
                            sessionID={params.id!}
                            messageID={message.id}
                            lastUserMessageID={lastUserMessage()?.id}
                            stepsExpanded={stepsExpanded()[message.id] ?? false}
                            onStepsExpandedToggle={() => toggleSteps(message.id)}
                            onRevertMessage={(id) => void revertTo(id)}
                            hideTools={["task"]}
                            classes={{
                              root: "min-w-0 w-full relative",
                              content: "flex flex-col justify-between !overflow-visible",
                              container: "w-full px-4 md:px-8",
                            }}
                          />
                          <Show when={index() < turnMessages().length - 1}>
                            <div class="w-full px-4 md:px-8 pt-2 pb-1">
                              <div
                                style={{
                                  height: "1px",
                                  background: "var(--color-border)",
                                  opacity: 0.6,
                                }}
                              />
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Match>
                <Match when={true}>
                  <ChatWelcome />
                </Match>
              </Switch>

              <Show when={revertInfo()}>
                <div style={{ padding: "8px 16px 0" }}>
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "12px",
                      padding: "8px 12px",
                      border: "1px solid var(--color-border)",
                      "border-radius": "6px",
                      "font-size": "12px",
                      "font-family": FONT_SANS,
                      color: "var(--color-text-secondary, var(--color-text))",
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
                        "border-radius": "4px",
                        "font-size": "12px",
                        cursor: "pointer",
                        "white-space": "nowrap",
                      }}
                    >
                      restore
                    </button>
                  </div>
                </div>
              </Show>

              <Composer />
            </div>

            {/* files — the host explorer, mounted on first visit */}
            <Show when={visitedFiles()}>
              <div
                style={{
                  display: centerTabs.active() === "files" ? "flex" : "none",
                  flex: 1,
                  "min-height": 0,
                  "flex-direction": "column",
                }}
              >
                <FileExplorer />
              </div>
            </Show>

            {/* document tabs — one inline FileView per opened file */}
            <For each={centerTabs.docs()}>
              {(doc) => (
                <div
                  style={{
                    display: centerTabs.active() === doc.id ? "flex" : "none",
                    flex: 1,
                    "min-height": 0,
                    "flex-direction": "column",
                  }}
                >
                  <FileView
                    path={doc.path}
                    directory={doc.directory}
                    subtitle={`This computer · ${doc.directory.replace(/\/$/, "")}/${doc.path}`}
                    onClose={() => centerTabs.closeDoc(doc.id)}
                  />
                </div>
              )}
            </For>
          </div>
        </div>

        <RightPane />
      </div>
    </div>
  )
}

function CenterTabStrip(props: { chatTitle: string }): JSX.Element {
  const active = centerTabs.active
  return (
    <div
      class="thesis-scroll"
      style={{
        display: "flex",
        "align-items": "stretch",
        gap: "5px",
        padding: "8px 12px",
        "border-bottom": "1px solid var(--color-border)",
        background: "var(--color-bg-subtle)",
        "overflow-x": "auto",
        "flex-shrink": 0,
      }}
    >
      <CenterTab active={active() === "chat"} label={props.chatTitle} onClick={() => centerTabs.setActive("chat")}>
        <IconMessageSquare size={12} strokeWidth={1.6} />
      </CenterTab>
      <CenterTab active={active() === "files"} label="Files" onClick={() => centerTabs.setActive("files")}>
        <IconFolderTree size={12} strokeWidth={1.6} />
      </CenterTab>
      <For each={centerTabs.docs()}>
        {(doc) => (
          <CenterTab
            active={active() === doc.id}
            label={doc.name}
            onClick={() => centerTabs.setActive(doc.id)}
            onClose={() => centerTabs.closeDoc(doc.id)}
          >
            <IconFile size={12} strokeWidth={1.6} />
          </CenterTab>
        )}
      </For>
    </div>
  )
}

function CenterTab(props: {
  active: boolean
  label: string
  onClick: () => void
  onClose?: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      title={props.label}
      style={{
        cursor: "pointer",
        display: "inline-flex",
        "align-items": "center",
        gap: "7px",
        "max-width": "220px",
        padding: "6px 10px",
        "border-radius": "4px",
        border: props.active ? "1px solid var(--color-border-strong)" : "1px solid transparent",
        background: props.active ? "var(--color-surface-solid)" : "transparent",
        "box-shadow": props.active ? "0 1px 2px rgba(0,0,0,0.10)" : "none",
        "font-family": FONT_MONO,
        "font-size": "11px",
        "font-weight": props.active ? 700 : 400,
        color: props.active ? "var(--color-text)" : "var(--color-text-muted)",
        transition: "background 120ms ease, color 120ms ease, border-color 120ms ease",
        "flex-shrink": 0,
      }}
      onMouseEnter={(e) => {
        if (!props.active) e.currentTarget.style.background = "var(--color-accent-subtle)"
      }}
      onMouseLeave={(e) => {
        if (!props.active) e.currentTarget.style.background = "transparent"
      }}
    >
      <span
        style={{
          display: "inline-flex",
          color: props.active ? "var(--color-text)" : "var(--color-text-faint)",
          "flex-shrink": 0,
        }}
      >
        {props.children}
      </span>
      <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{props.label}</span>
      <Show when={props.onClose}>
        <span
          role="button"
          aria-label="close tab"
          onClick={(e) => {
            e.stopPropagation()
            props.onClose!()
          }}
          style={{
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            width: "16px",
            height: "16px",
            "border-radius": "4px",
            color: "var(--color-text-faint)",
            "flex-shrink": 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--color-accent-subtle)"
            e.currentTarget.style.color = "var(--color-text)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent"
            e.currentTarget.style.color = "var(--color-text-faint)"
          }}
        >
          <IconX size={11} strokeWidth={1.8} />
        </span>
      </Show>
    </div>
  )
}

function Header(props: {
  projectName: string
  projectPath: string
  isDark: boolean
  onBack: () => void
  onOpenPalette: () => void
  onOpenHelp: () => void
  onOpenSettings: () => void
  onToggleTheme: () => void
}): JSX.Element {
  return (
    <AppHeader>
      <button
        onClick={props.onBack}
        title="back to projects"
        style={{
          all: "unset",
          cursor: "pointer",
          display: "inline-flex",
          "align-items": "center",
          gap: "5px",
          padding: "5px 10px",
          "border-radius": "4px",
          "font-family": FONT_MONO,
          "font-size": "11px",
          color: "var(--color-text-muted)",
          transition: "background 120ms ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-accent-subtle)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <IconChevronLeft size={11} strokeWidth={1.5} />
        projects
      </button>
      <HeaderDivider />
      <Wordmark size="sm" />
      <HeaderDivider />
      <span
        style={{
          "font-family": FONT_SANS,
          "font-size": "13px",
          "font-weight": 400,
          color: "var(--color-text)",
        }}
      >
        {props.projectName}
      </span>
      <span
        style={{
          "font-family": FONT_MONO,
          "font-size": "10px",
          color: "var(--color-text-faint)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          "max-width": "320px",
        }}
      >
        {props.projectPath}
      </span>
      <span style={{ flex: 1 }} />
      <HeaderIconButton onClick={props.onOpenPalette} title="command palette">
        <IconSearch size={13} strokeWidth={1.5} />
      </HeaderIconButton>
      <HeaderIconButton onClick={props.onOpenHelp} title="help">
        <IconBookOpen size={13} strokeWidth={1.5} />
      </HeaderIconButton>
      <HeaderIconButton onClick={props.onOpenSettings} title="settings">
        <IconSettings size={13} strokeWidth={1.5} />
      </HeaderIconButton>
      <HeaderIconButton onClick={props.onToggleTheme} title="toggle theme">
        <Show when={props.isDark} fallback={<IconMoon size={13} strokeWidth={1.5} />}>
          <IconSun size={13} strokeWidth={1.5} />
        </Show>
      </HeaderIconButton>
    </AppHeader>
  )
}

function SessionsSidebar(props: {
  sessions: SyncSession[]
  activeId: string | undefined
  dirParam: string
  creating: boolean
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}): JSX.Element {
  return (
    <aside
      class="thesis-scroll"
      style={{
        width: "240px",
        "min-width": "240px",
        "border-right": "1px solid var(--color-border)",
        background: "var(--color-bg-subtle)",
        display: "flex",
        "flex-direction": "column",
        "overflow-y": "auto",
      }}
    >
      <div
        style={{
          padding: "12px 14px 8px",
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
        }}
      >
        <button
          onClick={props.onNew}
          disabled={props.creating}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            "align-items": "center",
            gap: "6px",
            padding: "7px 12px",
            "border-radius": "4px",
            background: "linear-gradient(180deg, var(--color-surface-solid), var(--color-bg-subtle))",
            border: "1px solid var(--color-border-strong)",
            "font-family": FONT_MONO,
            "font-size": "12px",
            "font-weight": 400,
            color: "var(--color-text)",
            transition: "all 120ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-elevated)")}
          onMouseLeave={(e) =>
            (e.currentTarget.style.background =
              "linear-gradient(180deg, var(--color-surface-solid), var(--color-bg-subtle))")
          }
          onFocusIn={(e) => (e.currentTarget.style.background = "var(--color-bg-elevated)")}
          onFocusOut={(e) =>
            (e.currentTarget.style.background =
              "linear-gradient(180deg, var(--color-surface-solid), var(--color-bg-subtle))")
          }
        >
          <IconPlus size={11} strokeWidth={2} />
          {props.creating ? "creating…" : "new session"}
        </button>
      </div>
      <div
        style={{
          ...sectionTitle,
          padding: "0 16px 6px",
        }}
      >
        sessions · {props.sessions.length}
      </div>
      <div style={{ display: "flex", "flex-direction": "column", gap: "1px", padding: "0 8px" }}>
        <For each={props.sessions}>
          {(s) => (
            <SessionRow
              session={s}
              active={props.activeId === s.id}
              onSelect={() => props.onSelect(s.id)}
              onDelete={() => props.onDelete(s.id)}
            />
          )}
        </For>
        <Show when={props.sessions.length === 0}>
          <div
            style={{
              padding: "12px 10px",
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text-faint)",
              "line-height": 1.55,
            }}
          >
            no sessions yet · click <span style={{ color: "var(--color-text-muted)" }}>+ new session</span> above
          </div>
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
}): JSX.Element {
  const [hover, setHover] = createSignal(false)
  return (
    <div
      role="button"
      tabindex="0"
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          props.onSelect()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusIn={() => setHover(true)}
      onFocusOut={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false)
      }}
      style={{
        cursor: "pointer",
        display: "flex",
        "flex-direction": "column",
        gap: "2px",
        padding: "6px 10px",
        "padding-right": hover() ? "32px" : "10px",
        "border-radius": "4px",
        background: props.active ? "var(--color-bg-elevated)" : hover() ? "var(--color-accent-subtle)" : "transparent",
        transition: "background 120ms ease, padding 120ms ease",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <StatusDot status={props.active ? "active" : "muted"} size={9} />
        <span
          style={{
            "font-family": FONT_MONO,
            "font-size": "12px",
            color: props.active ? "var(--color-text)" : "var(--color-text-muted)",
            "font-weight": 400,
            flex: 1,
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {props.session.title || "session"}
        </span>
      </div>
      <div
        style={{
          "font-family": FONT_MONO,
          "font-size": "10px",
          color: "var(--color-text-faint)",
          "letter-spacing": "0.04em",
          "padding-left": "16px",
        }}
      >
        {props.session.time?.updated ? DateTime.fromMillis(props.session.time.updated).toRelative() : "—"}
      </div>
      <Show when={hover()}>
        <button
          type="button"
          title="delete session"
          aria-label="delete session"
          onPointerDown={(e) => {
            // Stop pointerdown on the parent row before its own click
            // can fire — Solid runs the row's onClick first otherwise.
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            props.onDelete()
          }}
          style={{
            position: "absolute",
            right: "6px",
            top: "50%",
            transform: "translateY(-50%)",
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            width: "22px",
            height: "22px",
            "border-radius": "4px",
            background: "var(--color-surface-solid)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-faint)",
            cursor: "pointer",
            transition: "all 120ms ease",
          }}
          onMouseEnter={(el) => {
            el.currentTarget.style.background = "var(--color-error-muted)"
            el.currentTarget.style.borderColor = "var(--color-error)"
            el.currentTarget.style.color = "var(--color-error)"
          }}
          onMouseLeave={(el) => {
            el.currentTarget.style.background = "var(--color-surface-solid)"
            el.currentTarget.style.borderColor = "var(--color-border)"
            el.currentTarget.style.color = "var(--color-text-faint)"
          }}
        >
          <IconTrash size={11} strokeWidth={1.5} />
        </button>
      </Show>
    </div>
  )
}

function ChatWelcome(): JSX.Element {
  return (
    <div
      class="thesis-fade-in"
      style={{
        flex: 1,
        display: "flex",
        "flex-direction": "column",
        "justify-content": "center",
        gap: "18px",
        padding: "0 32px",
        "max-width": "540px",
        "margin-inline": "auto",
        width: "100%",
      }}
    >
      <h2
        style={{
          margin: 0,
          "font-family": FONT_SERIF,
          "font-size": "27px",
          "line-height": 1.15,
          "font-weight": 400,
          "letter-spacing": "-0.02em",
          color: "var(--color-text)",
        }}
      >
        What are we working on?
        <span class="thesis-blink" style={{ color: "var(--color-text-faint)" }}>
          _
        </span>
      </h2>

      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
        <For each={WELCOME_MODES}>
          {(m) => (
            <button
              type="button"
              onClick={() => uiStore.setAgent(m.name)}
              title={m.hint}
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "5px 12px",
                "border-radius": "4px",
                border: uiStore.agent() === m.name ? "1px solid var(--color-border)" : "1px solid transparent",
                background: uiStore.agent() === m.name ? "var(--color-accent-subtle)" : "transparent",
                "font-family": FONT_MONO,
                "font-size": "11px",
                color: uiStore.agent() === m.name ? "var(--color-text)" : "var(--color-text-muted)",
                transition: "border-color 120ms ease, background 120ms ease, color 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (uiStore.agent() !== m.name) e.currentTarget.style.background = "var(--color-bg-elevated)"
              }}
              onMouseLeave={(e) => {
                if (uiStore.agent() !== m.name) e.currentTarget.style.background = "transparent"
              }}
            >
              {m.name}
            </button>
          )}
        </For>
      </div>

      <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
        <For each={WELCOME_PROMPTS}>
          {(p) => (
            <button
              type="button"
              onClick={() => uiStore.setPrefill(p)}
              style={{
                all: "unset",
                cursor: "pointer",
                display: "flex",
                "align-items": "baseline",
                gap: "9px",
                padding: "7px 2px",
                "font-family": FONT_SANS,
                "font-size": "13px",
                "line-height": 1.5,
                color: "var(--color-text-faint)",
                transition: "color 120ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--color-text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--color-text-faint)")}
            >
              <span style={{ color: "var(--color-text-faint)", "flex-shrink": 0 }}>→</span>
              {p}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

const WELCOME_MODES: { name: string; hint: string }[] = [
  { name: "research", hint: "literature + analysis" },
  { name: "biology", hint: "computational biology" },
  { name: "physics", hint: "simulation + theory" },
  { name: "ml", hint: "train + evaluate models" },
]

const WELCOME_PROMPTS: string[] = [
  "Survey recent work on this repo's research question and summarize open problems.",
  "Reproduce the main result and report what's missing to run it end-to-end.",
  "Draft an experiment plan with hypotheses, metrics, and ablations.",
]
