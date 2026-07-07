import {
  createSignal,
  createMemo,
  createResource,
  createEffect,
  onCleanup,
  type JSX,
  For,
  Show,
  Switch,
  Match,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { FONT_MONO, FONT_SANS, FONT_SERIF, sectionTitle } from "@/styles/tokens"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@synsci/ui/context/dialog"
import { SessionReview } from "@synsci/ui/session-review"
import { useTerminal } from "@/context/terminal"
import { Terminal } from "@/components/terminal"
import { confirmDialog } from "@/thesis/dialogs"
import { URLS } from "@/config/urls"
import { uiStore, type RightPaneTab } from "@/thesis/store/ui"
import { OpenScienceFileTree } from "@/thesis/OpenScienceFileTree"
import { FilePreview } from "@/thesis/FilePreview"
import { SkillLibraryDialog } from "@/thesis/SkillsBrowser"
import { ThesisCanvas } from "@/thesis/ThesisCanvas"
import { thesisAPI, type ThesisNode } from "@/thesis/api/thesis"
import { toast } from "@/thesis/Toast"
import {
  IconLayoutGrid,
  IconCpu,
  IconBraces,
  IconFolderTree,
  IconFolder,
  IconFile,
  IconNetwork,
  IconArchive,
  IconClock,
  IconArrowRight,
  IconRefresh,
  IconSearch,
  IconUpload,
  IconCheckCircle,
  IconAlertCircle,
  IconCopy,
  IconChevronRight,
  IconChevronLeft,
  IconChevronDown,
  IconSettings,
  IconTerminal,
  IconX,
} from "@/thesis/shared/Icon"
import { StatusDot, type StatusKind } from "@/thesis/shared/StatusDot"
import { BlinkCursor } from "@/thesis/shared/AsciiSpinner"

const RIGHT_PANE_WIDTH_KEY = "thesis-right-pane-width-v1"
const MIN_PANE_WIDTH = 280
const MAX_PANE_WIDTH = 880
const GITHUB_SETTINGS_URL = URLS.githubIntegration

function readSavedWidth(): number {
  try {
    const v = Number(localStorage.getItem(RIGHT_PANE_WIDTH_KEY))
    if (Number.isFinite(v) && v >= MIN_PANE_WIDTH && v <= MAX_PANE_WIDTH) return v
  } catch {}
  return 360
}

export function RightPane(): JSX.Element {
  const tab = uiStore.rightPaneTab
  const setTab = uiStore.setRightPaneTab
  // Keep-alive: once a tab has been opened it stays mounted (hidden via CSS),
  // so switching tabs never re-mounts/re-fetches/re-animates — no flash.
  const [visited, setVisited] = createSignal<Set<RightPaneTab>>(new Set([tab()]))
  createEffect(() => {
    const t = tab()
    setVisited((prev) => (prev.has(t) ? prev : new Set(prev).add(t)))
  })
  const dialog = useDialog()
  const [width, setWidth] = createSignal(readSavedWidth())
  const [panelMenu, setPanelMenu] = createSignal(false)
  const openSkillLibrary = () =>
    dialog.show(() => <SkillLibraryDialog onPick={(name) => uiStore.setPrefill(`/${name} `)} />)
  const TABS: { k: RightPaneTab; label?: string; Icon: (p: { size?: number; strokeWidth?: number }) => JSX.Element }[] =
    [
      { k: "canvas", label: "atlas", Icon: IconLayoutGrid },
      { k: "terminal", Icon: IconTerminal },
    ]
  const visibleTabs = createMemo(() => TABS.filter((t) => !uiStore.isTabHidden(t.k)))
  // Keep the active tab pointed at a visible one.
  createEffect(() => {
    const vis = visibleTabs()
    if (vis.length && !vis.some((t) => t.k === tab())) setTab(vis[0].k)
  })
  // Run a command requested from elsewhere (e.g. the Local models settings
  // panel's "run in terminal") in a fresh terminal tab, then reveal it.
  const terminal = useTerminal()
  createEffect(() => {
    const cmd = uiStore.terminalCommand()
    if (!cmd) return
    terminal.new({ command: cmd.command, args: cmd.args, title: cmd.title })
    setTab("terminal")
    uiStore.setRightPaneOpen(true)
    uiStore.setTerminalCommand(undefined)
  })
  let dragStart: { x: number; w: number } | null = null

  const onHandlePointerDown = (e: PointerEvent) => {
    dragStart = { x: e.clientX, w: width() }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    document.body.style.cursor = "ew-resize"
    e.preventDefault()
  }
  const onHandlePointerMove = (e: PointerEvent) => {
    if (!dragStart) return
    // Drag left = wider (handle is on left edge of right pane).
    const next = Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, dragStart.w + (dragStart.x - e.clientX)))
    setWidth(next)
  }
  const onHandlePointerUp = (e: PointerEvent) => {
    if (!dragStart) return
    dragStart = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    document.body.style.cursor = ""
    try {
      localStorage.setItem(RIGHT_PANE_WIDTH_KEY, String(width()))
    } catch {}
  }

  return (
    <Show
      when={uiStore.rightPaneOpen()}
      fallback={
        <CollapsedRail
          tabs={visibleTabs()}
          onOpen={(t) => {
            if (t) setTab(t)
            uiStore.setRightPaneOpen(true)
          }}
        />
      }
    >
      <aside
        style={{
          flex: `0 0 ${width()}px`,
          width: `${width()}px`,
          display: "flex",
          "flex-direction": "column",
          "border-left": "1px solid var(--color-border)",
          background: "var(--color-bg-subtle)",
          "min-width": `${MIN_PANE_WIDTH}px`,
          position: "relative",
        }}
      >
        {/* Drag handle on the left edge of the right pane. 6px wide, full
          height, invisible until hover. Cursor goes ew-resize. */}
        <div
          role="separator"
          aria-orientation="vertical"
          on:pointerdown={onHandlePointerDown}
          on:pointermove={onHandlePointerMove}
          on:pointerup={onHandlePointerUp}
          on:pointercancel={onHandlePointerUp}
          style={{
            position: "absolute",
            left: "-3px",
            top: 0,
            width: "6px",
            height: "100%",
            cursor: "ew-resize",
            "z-index": 5,
            "touch-action": "none",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-accent-subtle)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        />
        <div
          role="tablist"
          style={{
            display: "flex",
            "align-items": "stretch",
            "border-bottom": "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            "flex-shrink": 0,
          }}
        >
          <div
            style={{ display: "flex", gap: "5px", padding: "7px 10px", flex: 1, "min-width": 0, "overflow-x": "auto" }}
          >
            <For each={visibleTabs()}>
              {(t) => (
                <TabBtn k={t.k} label={t.label} Icon={t.Icon} active={tab() === t.k} onClick={() => setTab(t.k)} />
              )}
            </For>
          </div>
          <div style={{ position: "relative", display: "flex", "align-items": "center", "flex-shrink": 0 }}>
            <button onClick={openSkillLibrary} title="skill library" style={paneCtl(false)}>
              <IconBraces size={12} strokeWidth={1.5} />
            </button>
            <button onClick={() => setPanelMenu((v) => !v)} title="panel settings" style={paneCtl(panelMenu())}>
              <IconSettings size={12} strokeWidth={1.5} />
            </button>
            <Show when={panelMenu()}>
              <div
                onMouseLeave={() => setPanelMenu(false)}
                style={{
                  position: "absolute",
                  top: "100%",
                  right: "2px",
                  "margin-top": "2px",
                  background: "var(--color-surface-solid)",
                  border: "1px solid var(--color-border-strong)",
                  "border-radius": "4px",
                  "box-shadow": "var(--shadow-md)",
                  padding: "5px",
                  "z-index": 40,
                  "min-width": "150px",
                }}
              >
                <div style={paneMenuLabel}>show in panel</div>
                <For each={TABS}>
                  {(t) => (
                    <button onClick={() => uiStore.toggleTabHidden(t.k)} style={paneMenuRow()}>
                      <t.Icon size={12} strokeWidth={1.5} />
                      <span style={{ flex: 1, "text-align": "left" }}>{t.label ?? t.k}</span>
                      <span
                        style={{
                          "font-family": FONT_MONO,
                          "font-size": "10px",
                          color: uiStore.isTabHidden(t.k) ? "var(--color-text-faint)" : "var(--color-success)",
                        }}
                      >
                        {uiStore.isTabHidden(t.k) ? "off" : "on"}
                      </span>
                    </button>
                  )}
                </For>
                <div style={{ height: "1px", background: "var(--color-border)", margin: "4px 2px" }} />
                <button
                  onClick={() => {
                    uiStore.setRightPaneOpen(false)
                    setPanelMenu(false)
                  }}
                  style={paneMenuRow()}
                >
                  <IconChevronRight size={12} strokeWidth={1.5} />
                  <span style={{ flex: 1, "text-align": "left" }}>hide panel</span>
                </button>
              </div>
            </Show>
            <button onClick={() => uiStore.setRightPaneOpen(false)} title="hide panel" style={paneCtl(false)}>
              <IconChevronRight size={13} strokeWidth={1.5} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, "min-height": 0, position: "relative", display: "flex", "flex-direction": "column" }}>
          <KeepAlive show={tab() === "canvas"} mounted={visited().has("canvas")}>
            <CanvasTab />
          </KeepAlive>
          <KeepAlive show={tab() === "terminal"} mounted={visited().has("terminal")}>
            <TerminalTab />
          </KeepAlive>
        </div>
      </aside>
    </Show>
  )
}

function TerminalTab(): JSX.Element {
  const terminal = useTerminal()
  const sdk = useSDK()
  const loopback = () => {
    try {
      const host = new URL(sdk.url).hostname
      return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
    } catch {
      return false
    }
  }

  return (
    <div style={{ flex: 1, "min-height": 0, display: "flex", "flex-direction": "column" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          padding: "8px 10px",
          "border-bottom": "1px solid var(--color-border)",
          background: "var(--color-bg)",
          "flex-shrink": 0,
        }}
      >
        <IconTerminal size={13} strokeWidth={1.5} />
        <span style={{ "font-family": FONT_MONO, "font-size": "11px", color: "var(--color-text-muted)" }}>
          terminal
        </span>
        <span style={{ flex: 1 }} />
        <Show when={loopback()}>
          <button type="button" onClick={() => terminal.new()} style={smallAction()}>
            new
          </button>
        </Show>
      </div>
      <Show
        when={loopback()}
        fallback={
          <div
            style={{
              padding: "18px",
              "font-family": FONT_SANS,
              "font-size": "12px",
              color: "var(--color-text-muted)",
              "line-height": 1.5,
            }}
          >
            Terminal access is available only when <code>openscience web</code> is connected to a loopback server.
          </div>
        }
      >
        <Show
          when={terminal.all().length > 0}
          fallback={
            <div
              style={{
                flex: 1,
                display: "grid",
                "place-items": "center",
                padding: "22px",
                color: "var(--color-text-faint)",
                "font-family": FONT_SANS,
                "font-size": "12px",
              }}
            >
              <button type="button" onClick={() => terminal.new()} style={emptyAction()}>
                start terminal
              </button>
            </div>
          }
        >
          <div
            style={{
              display: "flex",
              gap: "4px",
              padding: "6px",
              "border-bottom": "1px solid var(--color-border)",
              "overflow-x": "auto",
              "flex-shrink": 0,
            }}
          >
            <For each={terminal.all()}>
              {(pty) => (
                <button
                  type="button"
                  onClick={() => terminal.open(pty.id)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    padding: "5px 8px",
                    "border-radius": "4px",
                    border: "1px solid var(--color-border)",
                    background: terminal.active() === pty.id ? "var(--color-accent-subtle)" : "var(--color-bg)",
                    "font-family": FONT_MONO,
                    "font-size": "11px",
                    color: "var(--color-text)",
                    display: "inline-flex",
                    "align-items": "center",
                    gap: "6px",
                  }}
                >
                  <span>{pty.title}</span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      void terminal.close(pty.id)
                    }}
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    ×
                  </span>
                </button>
              )}
            </For>
          </div>
          <div style={{ flex: 1, "min-height": 0, position: "relative" }}>
            <For each={terminal.all()}>
              {(pty) => (
                <div
                  id={`terminal-wrapper-${pty.id}`}
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: terminal.active() === pty.id ? "block" : "none",
                  }}
                >
                  <Terminal
                    pty={pty}
                    onCleanup={(next) => terminal.update(next)}
                    onConnectError={(e) =>
                      toast.error("terminal disconnected", e instanceof Error ? e.message : String(e))
                    }
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function CollapsedRail(props: {
  tabs: { k: RightPaneTab; Icon: (p: { size?: number; strokeWidth?: number }) => JSX.Element }[]
  onOpen: (t?: RightPaneTab) => void
}): JSX.Element {
  return (
    <aside
      style={{
        flex: "0 0 40px",
        width: "40px",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "4px",
        padding: "10px 0",
        "border-left": "1px solid var(--color-border)",
        background: "var(--color-bg-subtle)",
      }}
    >
      <button onClick={() => props.onOpen()} title="show panel" style={railBtn()}>
        <IconChevronLeft size={14} strokeWidth={1.5} />
      </button>
      <span style={{ width: "18px", height: "1px", background: "var(--color-border)", margin: "4px 0" }} />
      <For each={props.tabs}>
        {(t) => (
          <button onClick={() => props.onOpen(t.k)} title={t.k} style={railBtn()}>
            <t.Icon size={15} strokeWidth={1.5} />
          </button>
        )}
      </For>
    </aside>
  )
}

function paneCtl(active: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    padding: "0 8px",
    color: active ? "var(--color-text)" : "var(--color-text-faint)",
  } as JSX.CSSProperties
}

const paneMenuLabel: JSX.CSSProperties = {
  ...sectionTitle,
  padding: "4px 8px 3px",
}

function paneMenuRow(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "flex",
    "align-items": "center",
    gap: "7px",
    width: "100%",
    "box-sizing": "border-box",
    padding: "6px 8px",
    "border-radius": "4px",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text-muted)",
  } as JSX.CSSProperties
}

function smallAction(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "4px 8px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-elevated)",
    "font-family": FONT_MONO,
    "font-size": "10px",
    color: "var(--color-text)",
  } as JSX.CSSProperties
}

function emptyAction(): JSX.CSSProperties {
  return {
    ...smallAction(),
    padding: "7px 12px",
    "font-size": "11px",
  } as JSX.CSSProperties
}

function modalOverlayStyle(): JSX.CSSProperties {
  return {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    "z-index": 100,
  } as JSX.CSSProperties
}

function railBtn(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    position: "relative",
    width: "30px",
    height: "30px",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    "border-radius": "4px",
    color: "var(--color-text-muted)",
  } as JSX.CSSProperties
}

function TabBtn(props: {
  k: string
  label?: string
  Icon: (p: { size?: number; strokeWidth?: number }) => JSX.Element
  active: boolean
  onClick: () => void
  badge?: number
}): JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "inline-flex",
        "align-items": "center",
        gap: "7px",
        padding: "6px 10px",
        "border-radius": "4px",
        border: props.active ? "1px solid var(--color-border-strong)" : "1px solid transparent",
        background: props.active ? "var(--color-surface-solid)" : "transparent",
        "box-shadow": props.active ? "0 1px 2px rgba(0,0,0,0.10)" : "none",
        "font-family": FONT_MONO,
        "font-size": "11px",
        "font-weight": props.active ? 700 : 400,
        color: props.active ? "var(--color-text)" : "var(--color-text-muted)",
        transition:
          "background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
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
        <props.Icon size={12} strokeWidth={1.6} />
      </span>
      <span>{props.label ?? props.k}</span>
      <Show when={(props.badge ?? 0) > 0}>
        <span
          style={{
            "min-width": "15px",
            height: "15px",
            padding: "0 4px",
            "border-radius": "4px",
            background: "var(--color-accent)",
            color: "var(--color-on-accent)",
            "font-family": FONT_MONO,
            "font-size": "10px",
            "font-weight": 700,
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            "line-height": 1,
          }}
        >
          {props.badge}
        </span>
      </Show>
    </button>
  )
}

// ── Canvas ─────────────────────────────────────────────────────────
// Real Atlas graph: see ThesisCanvas.tsx. Backed by /api/thesis which
// the dev Vite plugin (vite-thesis.js) routes to the local @synsci/thesis
// CLI binary.

function KeepAlive(props: { show: boolean; mounted: boolean; children: JSX.Element }): JSX.Element {
  // Mounts children on first reveal and never unmounts them (mounted only
  // flips false→true). Visibility is pure CSS, so re-showing is instant and
  // never re-runs effects/fetches/animations.
  return (
    <Show when={props.mounted}>
      <div
        style={{
          display: props.show ? "flex" : "none",
          flex: props.show ? 1 : undefined,
          "min-height": 0,
          "min-width": 0,
          "flex-direction": "column",
          overflow: "hidden",
        }}
      >
        {props.children}
      </div>
    </Show>
  )
}

function CanvasTab(): JSX.Element {
  return <ThesisCanvas />
}

// ── Files (workspace / repo / artifacts / log) ─────────────────────

type FilesSubTab = "workspace" | "changes" | "repo" | "artifacts" | "log"

function FilesTab(): JSX.Element {
  const [sub, setSub] = createSignal<FilesSubTab>("workspace")
  const [seen, setSeen] = createSignal<Set<FilesSubTab>>(new Set([sub()]))
  createEffect(() => {
    const s = sub()
    setSeen((prev) => (prev.has(s) ? prev : new Set(prev).add(s)))
  })
  return (
    <div style={{ flex: 1, display: "flex", "flex-direction": "column", "min-height": 0 }}>
      <div
        style={{
          display: "flex",
          gap: "4px",
          padding: "8px 12px",
          "border-bottom": "1px solid var(--color-border)",
          "flex-shrink": 0,
          "overflow-x": "auto",
        }}
      >
        <SubTab
          Icon={IconArchive}
          label="workspace"
          active={sub() === "workspace"}
          onClick={() => setSub("workspace")}
        />
        <SubTab label="changes" active={sub() === "changes"} onClick={() => setSub("changes")} />
        <SubTab Icon={IconNetwork} label="repo" active={sub() === "repo"} onClick={() => setSub("repo")} />
        <SubTab label="artifacts" active={sub() === "artifacts"} onClick={() => setSub("artifacts")} />
        <SubTab Icon={IconClock} label="log" active={sub() === "log"} onClick={() => setSub("log")} />
      </div>
      <div style={{ flex: 1, "min-height": 0, display: "flex", "flex-direction": "column" }}>
        <KeepAlive show={sub() === "workspace"} mounted={seen().has("workspace")}>
          <WorkspaceView />
        </KeepAlive>
        <KeepAlive show={sub() === "changes"} mounted={seen().has("changes")}>
          <ChangesView />
        </KeepAlive>
        <KeepAlive show={sub() === "repo"} mounted={seen().has("repo")}>
          <RepoView />
        </KeepAlive>
        <KeepAlive show={sub() === "artifacts"} mounted={seen().has("artifacts")}>
          <ArtifactsView />
        </KeepAlive>
        <KeepAlive show={sub() === "log"} mounted={seen().has("log")}>
          <LogView />
        </KeepAlive>
      </div>
    </div>
  )
}

function ChangesView(): JSX.Element {
  const sync = useSync()
  const dialog = useDialog()
  const params = useParams()
  const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)
  const [busy, setBusy] = createSignal(false)

  createEffect(() => {
    const id = sessionID()
    if (id) void sync.session.diff(id).catch(() => {})
  })

  const diffs = createMemo(() => {
    const id = sessionID()
    if (!id) return []
    return sync.data.session_diff[id] ?? []
  })
  const session = createMemo(() => {
    const id = sessionID()
    return id ? sync.session.get(id) : undefined
  })
  const reverted = createMemo(() => !!session()?.revert)
  const firstUserMessage = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return (sync.data.message[id] ?? []).find((m) => m.role === "user")
  })

  const revertAll = async () => {
    const id = sessionID()
    const msg = firstUserMessage()
    if (!id || !msg) return
    const ok = await confirmDialog(dialog, {
      title: "Revert all changes?",
      message: "Roll back every file change the agent made in this session. You can undo this.",
      confirmLabel: "revert all",
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await sync.session.revert(id, msg.id)
      toast.success("changes reverted")
    } catch (e: any) {
      toast.error("revert failed", e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const undoRevert = async () => {
    const id = sessionID()
    if (!id) return
    setBusy(true)
    try {
      await sync.session.unrevert(id)
      toast.success("revert undone")
    } catch (e: any) {
      toast.error("undo failed", e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ flex: 1, "min-height": 0, display: "flex", "flex-direction": "column" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "8px 12px",
          "border-bottom": "1px solid var(--color-border)",
          "flex-shrink": 0,
        }}
      >
        <span style={{ "font-family": FONT_MONO, "font-size": "11px", color: "var(--color-text-faint)" }}>
          {diffs().length} changed {diffs().length === 1 ? "file" : "files"}
        </span>
        <span style={{ flex: 1 }} />
        <Show when={reverted()}>
          <button type="button" disabled={busy()} onClick={() => void undoRevert()} style={smallAction()}>
            undo revert
          </button>
        </Show>
        <Show when={!reverted() && diffs().length > 0 && firstUserMessage()}>
          <button type="button" disabled={busy()} onClick={() => void revertAll()} style={smallAction()}>
            revert all
          </button>
        </Show>
      </div>
      <div class="thesis-scroll" style={{ flex: 1, "min-height": 0, overflow: "auto" }}>
        <Show
          when={diffs().length > 0}
          fallback={
            <div
              style={{
                display: "grid",
                "place-items": "center",
                height: "100%",
                padding: "24px",
                "font-family": FONT_SANS,
                "font-size": "12px",
                color: "var(--color-text-faint)",
                "text-align": "center",
              }}
            >
              No file changes in this session yet.
            </div>
          }
        >
          <SessionReview diffs={diffs()} />
        </Show>
      </div>
    </div>
  )
}

function SubTab(props: {
  Icon?: (p: { size?: number; strokeWidth?: number }) => JSX.Element
  label: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "inline-flex",
        "align-items": "center",
        gap: "5px",
        padding: "4px 10px",
        "border-radius": "4px",
        "font-family": FONT_MONO,
        "font-size": "11px",
        "font-weight": 400,
        color: props.active ? "var(--color-text)" : "var(--color-text-muted)",
        background: props.active ? "var(--color-bg-elevated)" : "transparent",
        border: props.active ? "1px solid var(--color-border)" : "1px solid transparent",
        transition: "all var(--duration-fast) var(--ease-standard)",
      }}
    >
      <Show when={props.Icon}>{props.Icon!({ size: 11, strokeWidth: 1.7 })}</Show>
      {props.label}
    </button>
  )
}

function WorkspaceView(): JSX.Element {
  // The tree stays put; opening a file slides in a roomy, type-aware SIDE
  // PREVIEW pane (FilePreview) over the session — markdown renders formatted,
  // PDFs rasterize via pdfjs, LaTeX typesets with KaTeX, everything else gets a
  // syntax-highlighted / editable view. Far nicer than swapping the narrow
  // pane for a cramped textarea.
  const [path, setPath] = createSignal<string | undefined>()
  return (
    <div
      style={{
        flex: 1,
        "min-height": 0,
        "min-width": 0,
        overflow: "hidden",
        display: "flex",
        "flex-direction": "column",
      }}
    >
      <OpenScienceFileTree onOpen={setPath} />
      <Show when={path()}>{(p) => <FilePreview path={p()} onClose={() => setPath(undefined)} />}</Show>
    </div>
  )
}

interface RepoStatus {
  directory: string
  isGit: boolean
  branch: string
  remote: string
  github: { owner: string; name: string; url: string } | null
  upstream: string
  ahead: number
  behind: number
  head: string
  userName: string
  userEmail: string
  counts: {
    added: number
    modified: number
    deleted: number
    renamed: number
    untracked: number
    total: number
  }
  clean: boolean
  files: string[]
}

interface GitHubStatus {
  connected?: boolean
  connected_at?: string
  gh_username?: string
  gh_user_id?: string
  has_repo_scope?: boolean
  link_required?: boolean
  scopes?: string[]
  setup_url?: string
  token_expires_at?: string
  [key: string]: unknown
}

async function repoJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/repo/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error ?? `repo ${path} failed`)
  return data as T
}

async function repoStatus(directory: string): Promise<RepoStatus | { error: string }> {
  if (!directory) return { error: "no directory selected" }
  try {
    return await repoJSON<RepoStatus>(`status?directory=${encodeURIComponent(directory)}`)
  } catch (e: any) {
    return { error: e?.message ?? String(e) }
  }
}

function RepoView(): JSX.Element {
  const sync = useSync()
  const sdk = useSDK()
  const directory = () => sync.project?.worktree || sync.data.path.directory || sdk.directory
  const [refresh, setRefresh] = createSignal(0)
  const [repo] = createResource(
    () => [directory(), refresh()] as const,
    async ([dir]) => repoStatus(dir),
  )
  const [githubRefresh, setGithubRefresh] = createSignal(0)
  const [github] = createResource(
    () => String(githubRefresh()),
    async () => {
      try {
        return await thesisAPI.githubStatus()
      } catch (e: any) {
        return { error: e?.message ?? String(e) }
      }
    },
  )
  const [remote, setRemote] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [install, setInstall] = createSignal("")
  const [state, setState] = createSignal("")
  const [busy, setBusy] = createSignal("")

  // Read `.latest` so a manual refresh (or directory change) keeps the last
  // good status on screen while refetching instead of blanking the whole panel.
  const status = createMemo(() => {
    const value = repo.latest
    if (!value || "error" in value) return null
    return value
  })
  const error = createMemo(() => {
    const value = repo.latest
    if (value && "error" in value) return value.error
    return ""
  })
  const githubStatus = createMemo(() => {
    const value = github.latest
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    if ("error" in value) return null
    return value as GitHubStatus
  })
  const githubError = createMemo(() => {
    const value = github.latest
    if (value && typeof value === "object" && !Array.isArray(value) && "error" in value) return String(value.error)
    return ""
  })

  createEffect(() => {
    const url = status()?.remote
    if (url !== undefined) setRemote(url)
  })

  createEffect(() => {
    if (typeof window === "undefined" || install()) return
    const query = new URLSearchParams(window.location.search)
    const id = query.get("installation_id")
    const token = query.get("state")
    if (id) setInstall(id)
    if (token) setState(token)
  })

  const run = async (name: string, fn: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(name)
    try {
      await fn()
      toast.success(name)
      setRefresh((x) => x + 1)
      setGithubRefresh((x) => x + 1)
    } catch (e: any) {
      toast.error(`${name} failed`, e?.message ?? String(e))
    } finally {
      setBusy("")
    }
  }

  const commit = () =>
    run("commit", async () => {
      await repoJSON("commit", { directory: directory(), message: message() })
      setMessage("")
    })

  const push = () =>
    run("push", async () => {
      await repoJSON("push", { directory: directory(), branch: status()?.branch })
    })

  const saveRemote = () =>
    run("remote saved", async () => {
      await repoJSON("remote", { directory: directory(), url: remote() })
    })

  const linkGitHub = () =>
    run("GitHub linked", async () => {
      await thesisAPI.githubLink({ installationID: install(), state: state() || undefined })
      setInstall("")
      setState("")
    })

  const refreshGitHub = () =>
    run("GitHub refreshed", async () => {
      await thesisAPI.githubRefresh()
    })

  const disconnectGitHub = () =>
    run("GitHub disconnected", async () => {
      await thesisAPI.githubDisconnect()
    })

  const githubSetupUrl = () => String(githubStatus()?.setup_url ?? GITHUB_SETTINGS_URL)

  const openGitHubSetup = () => {
    window.open(githubSetupUrl(), "_blank", "noopener,noreferrer")
  }

  return (
    <div
      class="thesis-scroll"
      style={{
        flex: 1,
        "overflow-y": "auto",
        display: "flex",
        "flex-direction": "column",
        padding: "12px 14px 18px",
        gap: "12px",
      }}
    >
      <div style={repoHeaderStyle()}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px", "min-width": 0 }}>
          <IconNetwork size={13} strokeWidth={1.5} />
          <span style={{ "font-family": FONT_MONO, "font-size": "11px", color: "var(--color-text)" }}>repository</span>
          <Show when={status()?.github}>
            <a
              href={status()!.github!.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-muted)",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {status()!.github!.owner}/{status()!.github!.name}
            </a>
          </Show>
        </div>
        <button onClick={() => setRefresh((x) => x + 1)} title="refresh" style={iconBtn()}>
          <IconRefresh size={11} strokeWidth={1.5} />
        </button>
      </div>

      <Show
        when={status()}
        fallback={
          <div style={repoEmptyStyle()}>
            <IconAlertCircle size={16} strokeWidth={1.5} />
            <span>{error() || (repo.loading ? "loading repo…" : "not a git repository")}</span>
          </div>
        }
      >
        <div style={repoStatsGrid()}>
          <Stat label="branch" value={status()!.branch || "detached"} />
          <Stat label="head" value={status()!.head || "—"} />
          <Stat label="ahead" value={String(status()!.ahead)} />
          <Stat label="behind" value={String(status()!.behind)} />
        </div>

        <div style={repoPanel()}>
          <div style={repoPanelTitle()}>
            <Show when={status()!.clean} fallback={<IconAlertCircle size={12} strokeWidth={1.6} />}>
              <IconCheckCircle size={12} strokeWidth={1.6} />
            </Show>
            <span>{status()!.clean ? "clean worktree" : `${status()!.counts.total} changed files`}</span>
          </div>
          <Show when={!status()!.clean}>
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "5px" }}>
              <Badge text={`+${status()!.counts.added}`} />
              <Badge text={`~${status()!.counts.modified}`} />
              <Badge text={`-${status()!.counts.deleted}`} />
              <Badge text={`?${status()!.counts.untracked}`} />
            </div>
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                gap: "2px",
                "max-height": "120px",
                overflow: "auto",
              }}
            >
              <For each={status()!.files}>{(file) => <code style={repoFileLine()}>{file}</code>}</For>
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              <input
                value={message()}
                onInput={(e) => setMessage(e.currentTarget.value)}
                placeholder="commit message"
                style={repoInput()}
              />
              <button
                onClick={() => void commit()}
                disabled={!message().trim() || !!busy()}
                style={repoButton("primary", !message().trim() || !!busy())}
              >
                commit
              </button>
            </div>
          </Show>
        </div>

        <div style={repoPanel()}>
          <div style={repoPanelTitle()}>
            <IconUpload size={12} strokeWidth={1.6} />
            <span>{status()!.upstream || "origin"}</span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => void push()}
              disabled={!!busy() || !remote().trim()}
              style={repoButton("primary", !!busy() || !remote().trim())}
            >
              push
            </button>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <input
              value={remote()}
              onInput={(e) => setRemote(e.currentTarget.value)}
              placeholder="git@github.com:owner/repo.git"
              style={repoInput()}
            />
            <button
              onClick={() => void saveRemote()}
              disabled={!!busy() || !remote().trim()}
              style={repoButton("secondary", !!busy() || !remote().trim())}
            >
              save
            </button>
          </div>
        </div>
      </Show>

      <div style={repoPanel()}>
        <div style={repoPanelTitle()}>
          <IconNetwork size={12} strokeWidth={1.6} />
          <span>GitHub</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setGithubRefresh((x) => x + 1)} title="refresh GitHub" style={iconBtn()}>
            <IconRefresh size={11} strokeWidth={1.5} />
          </button>
        </div>
        <Show when={!github.loading || github.latest} fallback={<div style={repoEmptyStyle()}>loading GitHub…</div>}>
          <Show
            when={githubStatus()}
            fallback={<div style={repoEmptyStyle()}>{githubError() || "GitHub status unavailable"}</div>}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "7px", "flex-wrap": "wrap" }}>
              <Badge text={githubStatus()!.connected ? "connected" : "not connected"} />
              <Show when={githubStatus()!.gh_username}>
                <span style={{ "font-family": FONT_MONO, "font-size": "11px", color: "var(--color-text)" }}>
                  @{githubStatus()!.gh_username}
                </span>
              </Show>
              <Badge text={githubStatus()!.has_repo_scope ? "repo scope" : "public repo only"} />
            </div>
            <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
              <button onClick={openGitHubSetup} disabled={!!busy()} style={repoButton("primary", !!busy())}>
                {githubStatus()!.connected ? "settings" : "connect"}
              </button>
              <button
                onClick={() => void refreshGitHub()}
                disabled={!!busy()}
                style={repoButton("secondary", !!busy())}
              >
                refresh repos
              </button>
              <button
                onClick={() => void disconnectGitHub()}
                disabled={!!busy()}
                style={repoButton("secondary", !!busy())}
              >
                disconnect
              </button>
              <Show when={status()?.github?.url}>
                <button
                  onClick={() => navigator.clipboard?.writeText(status()!.github!.url)}
                  title="copy remote URL"
                  style={iconBtn()}
                >
                  <IconCopy size={11} strokeWidth={1.5} />
                </button>
              </Show>
            </div>
            <Show when={githubStatus()!.token_expires_at || githubStatus()!.scopes?.length}>
              <div
                style={{
                  "font-family": FONT_MONO,
                  "font-size": "10px",
                  color: "var(--color-text-faint)",
                  "line-height": 1.55,
                }}
              >
                <Show when={githubStatus()!.token_expires_at}>
                  <div>token expires {githubStatus()!.token_expires_at}</div>
                </Show>
                <Show when={githubStatus()!.scopes?.length}>
                  <div>scopes {githubStatus()!.scopes!.join(", ")}</div>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            value={install()}
            onInput={(e) => setInstall(e.currentTarget.value)}
            placeholder="installation id"
            style={repoInput()}
          />
          <input
            value={state()}
            onInput={(e) => setState(e.currentTarget.value)}
            placeholder="state"
            style={{ ...repoInput(), flex: "0 1 92px" }}
          />
          <button
            onClick={() => void linkGitHub()}
            disabled={!!busy() || !install().trim()}
            style={repoButton("primary", !!busy() || !install().trim())}
          >
            link
          </button>
        </div>
        <details>
          <summary
            style={{
              "font-family": FONT_MONO,
              "font-size": "10px",
              color: "var(--color-text-muted)",
              cursor: "pointer",
            }}
          >
            raw status
          </summary>
          <pre style={githubRaw()}>{JSON.stringify(github() ?? {}, null, 2)}</pre>
        </details>
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: string }): JSX.Element {
  return (
    <div style={repoStat()}>
      <span style={sectionTitle}>{props.label}</span>
      <span
        style={{
          color: "var(--color-text)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          "font-size": "11px",
        }}
      >
        {props.value}
      </span>
    </div>
  )
}

function Badge(props: { text: string }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        "align-items": "center",
        padding: "2px 6px",
        "border-radius": "4px",
        border: "1px solid var(--color-border)",
        background: "var(--color-bg-subtle)",
        "font-family": FONT_MONO,
        "font-size": "10px",
        color: "var(--color-text-muted)",
      }}
    >
      {props.text}
    </span>
  )
}

function repoHeaderStyle(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "8px",
    padding: "8px 10px",
    border: "1px solid var(--color-border)",
    "border-radius": "4px",
    background: "var(--color-surface-solid)",
  } as JSX.CSSProperties
}

function repoEmptyStyle(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "8px",
    padding: "18px 12px",
    border: "1px dashed var(--color-border)",
    "border-radius": "4px",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text-faint)",
  } as JSX.CSSProperties
}

function repoStatsGrid(): JSX.CSSProperties {
  return {
    display: "grid",
    "grid-template-columns": "repeat(2, minmax(0, 1fr))",
    gap: "6px",
  } as JSX.CSSProperties
}

function repoStat(): JSX.CSSProperties {
  return {
    display: "flex",
    "flex-direction": "column",
    gap: "3px",
    padding: "8px 9px",
    border: "1px solid var(--color-border)",
    "border-radius": "4px",
    background: "var(--color-surface-solid)",
    "font-family": FONT_MONO,
    "min-width": 0,
  } as JSX.CSSProperties
}

function repoPanel(): JSX.CSSProperties {
  return {
    display: "flex",
    "flex-direction": "column",
    gap: "8px",
    padding: "10px",
    border: "1px solid var(--color-border)",
    "border-radius": "4px",
    background: "var(--color-surface-solid)",
  } as JSX.CSSProperties
}

function repoPanelTitle(): JSX.CSSProperties {
  return {
    display: "flex",
    "align-items": "center",
    gap: "7px",
    "font-family": FONT_MONO,
    "font-size": "11px",
    "font-weight": 700,
    color: "var(--color-text)",
  } as JSX.CSSProperties
}

function repoFileLine(): JSX.CSSProperties {
  return {
    display: "block",
    "font-family": FONT_MONO,
    "font-size": "10px",
    color: "var(--color-text-muted)",
    background: "var(--color-bg-subtle)",
    padding: "3px 6px",
    "border-radius": "4px",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  } as JSX.CSSProperties
}

function repoInput(): JSX.CSSProperties {
  return {
    all: "unset",
    flex: 1,
    "min-width": 0,
    "box-sizing": "border-box",
    padding: "6px 8px",
    border: "1px solid var(--color-border)",
    "border-radius": "4px",
    background: "var(--color-bg-elevated)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text)",
  } as JSX.CSSProperties
}

function repoButton(kind: "primary" | "secondary", disabled: boolean): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    padding: "6px 9px",
    "border-radius": "4px",
    border: kind === "primary" ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
    background: kind === "primary" ? "var(--color-text)" : "var(--color-bg-subtle)",
    color: kind === "primary" ? "var(--color-bg)" : "var(--color-text-muted)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    "font-weight": kind === "primary" ? 700 : 400,
    opacity: disabled ? 0.45 : 1,
    "white-space": "nowrap",
  } as JSX.CSSProperties
}

function iconBtn(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: "24px",
    height: "24px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-subtle)",
    color: "var(--color-text-muted)",
    "flex-shrink": 0,
  } as JSX.CSSProperties
}

function githubRaw(): JSX.CSSProperties {
  return {
    margin: 0,
    "max-height": "130px",
    overflow: "auto",
    padding: "7px 8px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-subtle)",
    "font-family": FONT_MONO,
    "font-size": "10px",
    color: "var(--color-text-muted)",
    "white-space": "pre-wrap",
  } as JSX.CSSProperties
}

function ArtifactsView(): JSX.Element {
  type Row = { node: ThesisNode; artifact: { name?: string; kind?: string; uri?: string; bytes?: number } }
  const sync = useSync()
  const sdk = useSDK()
  // Scope to THIS project's graph — never load every node across all projects
  // (cross-project + cross-owner, and N+1). Resolve the folder's root, load its
  // subtree, then artifacts per node (now a handful, not hundreds).
  const directory = () => sync.project?.worktree || sync.data.path.directory || sdk.directory
  const [data] = createResource(directory, async (dir) => {
    try {
      const pid = (await thesisAPI.resolveProject(dir)).project_id
      if (!pid) return [] as Row[]
      const tree = await thesisAPI.getGraphTree(pid)
      const rows: Row[] = []
      for (const node of tree.nodes ?? []) {
        try {
          const res = await thesisAPI.listArtifacts(node.node_id)
          const items = Array.isArray(res) ? res : (res.artifacts ?? [])
          for (const a of items) rows.push({ node, artifact: a })
        } catch {}
      }
      return rows
    } catch {
      return [] as Row[]
    }
  })
  return (
    <div
      class="thesis-scroll"
      style={{
        flex: 1,
        "overflow-y": "auto",
        padding: "8px 12px",
        display: "flex",
        "flex-direction": "column",
        gap: "4px",
      }}
    >
      <Show
        when={(data.latest ?? []).length > 0}
        fallback={
          <div
            style={{
              flex: 1,
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "font-family": FONT_MONO,
              "font-size": "11px",
              color: "var(--color-text-faint)",
              "text-align": "center",
              padding: "40px 20px",
            }}
          >
            <Show when={data.loading} fallback={<span>no artifacts yet · attach a file to seed one</span>}>
              loading artifacts…
            </Show>
          </div>
        }
      >
        <For each={data.latest ?? []}>
          {(row) => (
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                padding: "6px 8px",
                "border-radius": "4px",
                "font-family": FONT_MONO,
                "font-size": "11px",
                "border-bottom": "1px solid var(--color-border)",
              }}
            >
              <span
                style={{
                  color: "var(--color-text-faint)",
                  "min-width": "44px",
                  "font-size": "10px",
                }}
              >
                {row.artifact.kind ?? "—"}
              </span>
              <span
                style={{
                  flex: 1,
                  color: "var(--color-text)",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}
              >
                {row.artifact.name ?? row.artifact.uri ?? "?"}
              </span>
              <span style={{ color: "var(--color-text-muted)", "font-size": "10px" }}>
                {row.node.title?.slice(0, 22) ?? row.node.slug_name ?? "—"}
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function LogView(): JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "font-family": FONT_MONO,
        "font-size": "11px",
        color: "var(--color-text-faint)",
      }}
    >
      activity log will stream here
    </div>
  )
}

function EmptyRow(props: { text: string }): JSX.Element {
  return (
    <div
      style={{
        "font-family": FONT_MONO,
        "font-size": "11px",
        color: "var(--color-text-faint)",
        padding: "6px 0",
      }}
    >
      {props.text}
    </div>
  )
}

function Section(props: { label: string; count: number; children: JSX.Element; refreshable?: boolean }): JSX.Element {
  return (
    <section>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          "margin-bottom": "8px",
          ...sectionTitle,
        }}
      >
        <span>{props.label}</span>
        <span style={{ color: "var(--color-text-muted)" }}>· {props.count}</span>
        <span style={{ flex: 1 }} />
        <Show when={props.refreshable}>
          <button
            title="refresh"
            style={{
              all: "unset",
              cursor: "pointer",
              color: "var(--color-text-faint)",
              display: "inline-flex",
              padding: "2px",
            }}
          >
            <IconRefresh size={11} strokeWidth={1.5} />
          </button>
        </Show>
      </div>
      <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>{props.children}</div>
    </section>
  )
}

function Code(props: { children: JSX.Element }): JSX.Element {
  return (
    <code
      style={{
        "font-family": FONT_MONO,
        "font-size": "11px",
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
        padding: "0 4px",
        "border-radius": "4px",
        color: "var(--color-text-muted)",
      }}
    >
      {props.children}
    </code>
  )
}
