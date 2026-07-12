import { createSignal, createMemo, createEffect, type JSX, For, Show } from "solid-js"
import { FONT_MONO, FONT_SANS, sectionTitle } from "@/styles/tokens"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useDialog } from "@synsci/ui/context/dialog"
import { useTerminal } from "@/context/terminal"
import { Terminal } from "@/components/terminal"
import { uiStore, type RightPaneTab } from "@/atlas/store/ui"
import { SkillLibraryDialog } from "@/atlas/SkillsBrowser"
import { AtlasCanvas } from "@/atlas/AtlasCanvas"
import { toast } from "@/atlas/Toast"
import {
  IconLayoutGrid,
  IconBraces,
  IconChevronRight,
  IconChevronLeft,
  IconSettings,
  IconTerminal,
} from "@/atlas/shared/Icon"

const RIGHT_PANE_WIDTH_KEY = "thesis-right-pane-width-v1"
const MIN_PANE_WIDTH = 280
const MAX_PANE_WIDTH = 880

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
  const language = useLanguage()
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
      { k: "canvas", label: language.t("panel.tab.atlas"), Icon: IconLayoutGrid },
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
            <button onClick={openSkillLibrary} title={language.t("panel.action.skillLibrary")} style={paneCtl(false)}>
              <IconBraces size={12} strokeWidth={1.5} />
            </button>
            <button onClick={() => setPanelMenu((v) => !v)} title={language.t("panel.action.settings")} style={paneCtl(panelMenu())}>
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
                <div style={paneMenuLabel}>{language.t("panel.menu.show")}</div>
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
                        {uiStore.isTabHidden(t.k) ? language.t("panel.status.off") : language.t("panel.status.on")}
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
                  <span style={{ flex: 1, "text-align": "left" }}>{language.t("panel.action.hide")}</span>
                </button>
              </div>
            </Show>
            <button onClick={() => uiStore.setRightPaneOpen(false)} title={language.t("panel.action.hide")} style={paneCtl(false)}>
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
  const language = useLanguage()
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
          {language.t("panel.label.terminal")}
        </span>
        <span style={{ flex: 1 }} />
        <Show when={loopback()}>
            <button type="button" onClick={() => terminal.new()} style={smallAction()}>
              {language.t("panel.action.newTerminal")}
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
              {language.t("panel.terminal.loopbackOnly")}
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
                {language.t("panel.terminal.start")}
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
                    onConnectError={(e) => toast.error(language.t("panel.terminal.disconnected"), e.message)}
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
  const language = useLanguage()
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
      <button onClick={() => props.onOpen()} title={language.t("panel.action.show")} style={railBtn()}>
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
// Real Atlas graph: see AtlasCanvas.tsx. Backed by /api/atlas which
// the dev Vite plugin (vite-atlas.js) routes to the local @synsci/atlas
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
  return <AtlasCanvas />
}
