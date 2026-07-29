import { createSignal, createMemo, createEffect, onCleanup, onMount, type JSX, For, Show } from "solid-js"
import { FONT_MONO, FONT_SANS, sectionTitle } from "@/styles/tokens"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@synsci/ui/context/dialog"
import { useTerminal } from "@/context/terminal"
import { Terminal } from "@/components/terminal"
import { uiStore, type RightPaneTab } from "@/atlas/store/ui"
import { SkillLibraryDialog } from "@/atlas/SkillsBrowser"
import { AtlasCanvas } from "@/atlas/AtlasCanvas"
import { ComputeJobs } from "@/atlas/ComputeJobs"
import { EvidenceGraph } from "@/atlas/EvidenceGraph"
import { artifactContext } from "@/artifacts/context"
import { ArtifactInspector } from "@/artifacts/ArtifactInspector"
import { toast } from "@/atlas/Toast"
import {
  IconAtom,
  IconLayoutGrid,
  IconBraces,
  IconChevronRight,
  IconChevronLeft,
  IconSettings,
  IconTerminal,
  IconActivity,
  IconNetwork,
} from "@/atlas/shared/Icon"

const RIGHT_PANE_WIDTH_KEY = "openscience-research-inspector-width-v2"
const MIN_PANE_WIDTH = 280
const MAX_PANE_WIDTH = 680

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
  const artifact = artifactContext.active
  const artifactMode = () => Boolean(artifact()) && uiStore.rightPaneMode() === "artifact"
  // Keep-alive: once a tab has been opened it stays mounted (hidden via CSS),
  // so switching tabs never re-mounts/re-fetches/re-animates — no flash.
  const [visited, setVisited] = createSignal<Set<RightPaneTab>>(new Set([tab()]))
  createEffect(() => {
    const t = tab()
    setVisited((prev) => (prev.has(t) ? prev : new Set(prev).add(t)))
  })
  const dialog = useDialog()
  const [width, setWidth] = createSignal(readSavedWidth())
  const [narrow, setNarrow] = createSignal(typeof window !== "undefined" && window.innerWidth < 1100)
  const [panelMenu, setPanelMenu] = createSignal(false)
  onMount(() => {
    const resize = () => setNarrow(window.innerWidth < 1100)
    window.addEventListener("resize", resize)
    onCleanup(() => window.removeEventListener("resize", resize))
  })
  const openSkillLibrary = () =>
    dialog.show(() => <SkillLibraryDialog onPick={(name) => uiStore.setPrefill(`/${name} `)} />)
  const TABS: { k: RightPaneTab; label?: string; Icon: (p: { size?: number; strokeWidth?: number }) => JSX.Element }[] =
    [
      { k: "canvas", label: "Atlas", Icon: IconLayoutGrid },
      { k: "evidence", label: "Evidence", Icon: IconNetwork },
      { k: "jobs", label: "Compute", Icon: IconActivity },
      { k: "terminal", label: "Terminal", Icon: IconTerminal },
    ]
  const visibleTabs = createMemo(() => TABS.filter((t) => !uiStore.isTabHidden(t.k)))
  // Keep the active tab pointed at a visible one.
  createEffect(() => {
    const vis = visibleTabs()
    if (vis.length && !vis.some((t) => t.k === tab())) setTab(vis[0].k)
  })
  createEffect(() => {
    const id = artifact()?.id
    if (!id) return
    uiStore.setRightPaneMode("artifact")
    uiStore.setRightPaneOpen(true)
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
          artifact={Boolean(artifact())}
          onInspect={() => {
            uiStore.setRightPaneMode("artifact")
            uiStore.setRightPaneOpen(true)
          }}
          tabs={visibleTabs()}
          onOpen={(t) => {
            if (t) {
              setTab(t)
              uiStore.setRightPaneMode("tools")
            }
            uiStore.setRightPaneOpen(true)
          }}
        />
      }
    >
      <>
        <Show when={narrow()}>
          <button
            type="button"
            class="session-right-pane-backdrop"
            aria-label="Close inspector overlay"
            onClick={() => uiStore.setRightPaneOpen(false)}
            style={{
              all: "unset",
              position: "fixed",
              inset: 0,
              "z-index": 69,
              cursor: "default",
              background: "color-mix(in srgb, var(--color-bg) 62%, transparent)",
              "backdrop-filter": "blur(1px)",
            }}
          />
        </Show>
        <aside
          class="session-right-pane"
          data-overlay={narrow() ? "true" : "false"}
          style={{
            flex: narrow() ? "none" : `0 0 ${width()}px`,
            width: narrow() ? "min(380px, calc(100vw - 44px))" : `${width()}px`,
            "min-width": narrow() ? "280px" : `${MIN_PANE_WIDTH}px`,
            position: narrow() ? "fixed" : "relative",
            top: narrow() ? "0" : undefined,
            right: narrow() ? "0" : undefined,
            bottom: narrow() ? "0" : undefined,
            "z-index": narrow() ? 70 : undefined,
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
          <div class="research-inspector__tabs" role="tablist">
            <div class="research-inspector__tab-list">
              <Show when={artifact()}>
                <TabBtn
                  k="artifact"
                  label="Inspect"
                  Icon={IconAtom}
                  active={artifactMode()}
                  onClick={() => uiStore.setRightPaneMode("artifact")}
                />
              </Show>
              <For each={visibleTabs()}>
                {(t) => (
                  <TabBtn
                    k={t.k}
                    label={t.label}
                    Icon={t.Icon}
                    active={!artifactMode() && tab() === t.k}
                    onClick={() => {
                      setTab(t.k)
                      uiStore.setRightPaneMode("tools")
                    }}
                  />
                )}
              </For>
            </div>
            <div class="research-inspector__controls">
              <button class="research-inspector__control" onClick={openSkillLibrary} title="skill library">
                <IconBraces size={12} strokeWidth={1.5} />
              </button>
              <button
                class="research-inspector__control"
                data-active={panelMenu() ? "true" : "false"}
                onClick={() => setPanelMenu((v) => !v)}
                title="panel settings"
              >
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
              <button
                class="research-inspector__control"
                onClick={() => uiStore.setRightPaneOpen(false)}
                title="hide panel"
              >
                <IconChevronRight size={13} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          <div style={{ flex: 1, "min-height": 0, position: "relative", display: "flex", "flex-direction": "column" }}>
            <Show when={artifactMode() && artifact()}>
              {(current) => <ArtifactInspector context={current()} onClose={() => uiStore.setRightPaneMode("tools")} />}
            </Show>
            <div
              style={{
                display: artifactMode() ? "none" : "flex",
                flex: artifactMode() ? undefined : 1,
                "min-height": 0,
                "flex-direction": "column",
              }}
            >
              <KeepAlive show={tab() === "canvas"} mounted={visited().has("canvas")}>
                <CanvasTab />
              </KeepAlive>
              <KeepAlive show={tab() === "jobs"} mounted={visited().has("jobs")}>
                <ComputeJobs />
              </KeepAlive>
              <KeepAlive show={tab() === "evidence"} mounted={visited().has("evidence")}>
                <EvidenceGraph />
              </KeepAlive>
              <KeepAlive show={tab() === "terminal"} mounted={visited().has("terminal")}>
                <TerminalTab />
              </KeepAlive>
            </div>
          </div>
        </aside>
      </>
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
                    onConnectError={(e) => toast.error("terminal disconnected", e.message)}
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
  artifact: boolean
  onInspect: () => void
  tabs: { k: RightPaneTab; label?: string; Icon: (p: { size?: number; strokeWidth?: number }) => JSX.Element }[]
  onOpen: (t?: RightPaneTab) => void
}): JSX.Element {
  return (
    <aside class="research-tool-rail">
      <button
        class="research-tool-rail__button"
        onClick={() => props.onOpen()}
        title="show panel"
        aria-label="show panel"
      >
        <IconChevronLeft size={14} strokeWidth={1.5} />
      </button>
      <span class="research-tool-rail__divider" />
      <Show when={props.artifact}>
        <button
          class="research-tool-rail__button"
          onClick={props.onInspect}
          title="inspect artifact"
          aria-label="inspect artifact"
        >
          <IconAtom size={15} strokeWidth={1.5} />
        </button>
      </Show>
      <For each={props.tabs}>
        {(t) => (
          <button
            class="research-tool-rail__button"
            onClick={() => props.onOpen(t.k)}
            title={t.label ?? t.k}
            aria-label={t.label ?? t.k}
          >
            <t.Icon size={15} strokeWidth={1.5} />
          </button>
        )}
      </For>
    </aside>
  )
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
      class="research-inspector__tab"
      data-active={props.active ? "true" : "false"}
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
    >
      <span class="research-inspector__tab-icon">
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
// Real Atlas graph: see AtlasCanvas.tsx. The selected OpenScience server owns
// the /api/atlas bridge in both bundled and separately hosted deployments.

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
