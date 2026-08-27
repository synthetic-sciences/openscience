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
  Suspense,
  Switch,
  type JSX,
} from "solid-js"
import { uiStore, type ContextTab, type WorkTab } from "@/atlas/store/ui"
import { AtlasCanvas } from "@/atlas/AtlasCanvas"
import { ComputeSurface } from "@/atlas/ComputeSurface"
import { ExternalFileAccess } from "@/atlas/FileExplorer"
import { FilesPane } from "@/atlas/FilesPane"
import { FileView } from "@/atlas/FilePreview"
import { TerminalSurface } from "@/atlas/TerminalSurface"
import { SessionTraceSurface } from "@/atlas/SessionTraceSurface"
import { artifactContext } from "@/artifacts/context"
import { useDialog } from "@synsci/ui/context/dialog"
import { FileIcon } from "@synsci/ui/file-icon"
import { ArtifactInspector } from "@/artifacts/ArtifactInspector"
import { StoredArtifactView } from "@/artifacts/StoredArtifactView"
import { confirmDialog } from "@/atlas/dialogs"
import { discardFileDraft } from "@/atlas/file-drafts"
import { AsciiSpinner } from "@/atlas/shared/AsciiSpinner"
import {
  IconActivity,
  IconArchive,
  IconArtifact,
  IconChevronLeft,
  IconCollapse,
  IconCpu,
  IconExpand,
  IconFolder,
  IconNetwork,
  IconSplit,
  IconTerminal,
  IconX,
} from "@/atlas/shared/Icon"
import {
  DEFAULT_PANE_WIDTH,
  MIN_PANE_WIDTH,
  INLINE_PANE_BREAKPOINT,
  clampPaneWidth,
  equalPaneWidth,
  legacyPaneWidthKey,
  maxPaneWidthForWorkspace,
  paneWidthForWorkspace,
  paneWidthKey,
  readPaneWidth,
  savePaneWidth,
} from "@/atlas/right-pane-layout"
import "./right-pane-tabs.css"

const RESIZE_STEP = 16
const labels: Record<ContextTab, string> = {
  artifact: "Artifact details",
  files: "Files",
  terminal: "Terminal",
  canvas: "Synthetic Sciences",
  kernels: "Compute",
  trace: "Trace",
}

export function RightPaneGate(props: { children: JSX.Element }): JSX.Element {
  createEffect(() => uiStore.syncArtifact(Boolean(artifactContext.active())))
  const [terminal, setTerminal] = createSignal(uiStore.rightPaneOpen() && uiStore.context() === "terminal")
  createEffect(() => {
    if (!uiStore.rightPaneOpen() || uiStore.context() !== "terminal") return
    setTerminal(true)
  })
  const retained = () => terminal() || uiStore.workTabs().some((tab) => tab.kind === "file")
  return (
    <Show when={uiStore.rightPaneOpen() || retained()}>
      <div class="right-pane-gate" data-open={uiStore.rightPaneOpen() ? "true" : "false"}>
        {props.children}
      </div>
    </Show>
  )
}

const focusable =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

export function RightPaneFrame(props: {
  modal: boolean
  mobile: boolean
  stacked: boolean
  expanded?: boolean
  width: number
  onClose: () => void
  onPane?: (element: HTMLElement) => void
  children: JSX.Element
}): JSX.Element {
  const refs: {
    pane?: HTMLElement
    prior?: HTMLElement
    modal: boolean
  } = { modal: false }

  createEffect(() => {
    if (!props.modal) {
      const prior = refs.modal ? refs.prior : undefined
      refs.modal = false
      refs.prior = undefined
      if (prior?.isConnected) queueMicrotask(() => prior.focus())
      return
    }
    if (refs.modal) return
    refs.modal = true
    const active = document.activeElement
    refs.prior = active instanceof HTMLElement ? active : undefined
    queueMicrotask(() => {
      if (!refs.modal || !refs.pane) return
      const initial =
        refs.pane.querySelector<HTMLElement>("[data-modal-initial-focus]") ??
        refs.pane.querySelector<HTMLElement>(focusable)
      ;(initial ?? refs.pane).focus()
    })
  })

  onCleanup(() => {
    const prior = refs.modal ? refs.prior : undefined
    refs.modal = false
    if (!prior?.isConnected) return
    prior.focus()
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (!props.modal) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.key !== "Tab" || !refs.pane) return
    const items = Array.from(refs.pane.querySelectorAll<HTMLElement>(focusable)).filter(
      (item) => !item.closest('[hidden], [aria-hidden="true"], [inert]'),
    )
    if (!items.length) {
      event.preventDefault()
      refs.pane.focus()
      return
    }
    const active = document.activeElement
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && (active === first || !refs.pane.contains(active))) {
      event.preventDefault()
      last.focus()
      return
    }
    if (event.shiftKey || (active !== last && refs.pane.contains(active))) return
    event.preventDefault()
    first.focus()
  }

  return (
    <>
      <Show when={props.modal}>
        <button
          type="button"
          class="session-right-pane-backdrop"
          aria-label="Close inspector overlay"
          aria-hidden="true"
          tabindex={-1}
          onClick={props.onClose}
          style={{
            position: "fixed",
            inset: 0,
            "z-index": 69,
            cursor: "default",
          }}
        />
      </Show>
      <aside
        ref={(element) => {
          refs.pane = element
          props.onPane?.(element)
        }}
        class="session-right-pane"
        aria-label="Research inspector"
        role={props.modal ? "dialog" : undefined}
        aria-modal={props.modal ? "true" : undefined}
        tabindex={props.modal ? -1 : undefined}
        data-overlay={props.modal ? "true" : "false"}
        data-mobile={props.mobile ? "true" : "false"}
        data-stacked={props.stacked ? "true" : "false"}
        data-expanded={props.expanded ? "true" : "false"}
        onKeyDown={onKeyDown}
        style={{
          flex: props.modal || props.stacked ? "none" : `0 0 ${props.width}px`,
          width: props.expanded
            ? "100vw"
            : props.mobile
              ? "100vw"
              : props.stacked
                ? "100%"
                : props.modal
                  ? "min(520px, calc(100vw - 48px))"
                  : `${props.width}px`,
          height: props.expanded ? "100dvh" : props.stacked ? "100%" : undefined,
          "min-width":
            props.expanded || props.mobile || props.stacked ? "0" : props.modal ? "360px" : `${MIN_PANE_WIDTH}px`,
          position: props.modal ? "fixed" : "relative",
          inset: props.expanded ? "0" : undefined,
          top: props.modal && !props.expanded ? "0" : undefined,
          right: props.modal && !props.expanded ? "0" : undefined,
          bottom: props.modal && !props.expanded ? "0" : undefined,
          "z-index": props.expanded ? 90 : props.modal ? 70 : undefined,
        }}
      >
        {props.children}
      </aside>
    </>
  )
}

export function RightPane(
  props: {
    project?: string
    session?: string
    route?: string
  } = {},
): JSX.Element {
  const context = uiStore.context
  const artifact = artifactContext.active
  const project = () => props.project ?? props.route ?? window.location.pathname
  const session = () => props.session ?? "new"
  const key = createMemo(() => paneWidthKey(project()))
  const legacy = createMemo(() => [
    legacyPaneWidthKey(project(), session()),
    ...(props.project && props.session ? [legacyPaneWidthKey(`${props.project}/${props.session}`)] : []),
  ])
  const initial = () => {
    try {
      return readPaneWidth(key(), localStorage, legacy())
    } catch {
      return DEFAULT_PANE_WIDTH
    }
  }
  const [width, setWidth] = createSignal(initial())
  const [expanded, setExpanded] = createSignal(false)
  const [dirtyFiles, setDirtyFiles] = createSignal<string[]>([])
  const dialog = useDialog()
  const [workspace, setWorkspace] = createSignal(typeof window === "undefined" ? 1200 : window.innerWidth)
  const [persistentSidebar, setPersistentSidebar] = createSignal(0)
  const [narrow, setNarrow] = createSignal(typeof window !== "undefined" && window.innerWidth < INLINE_PANE_BREAKPOINT)
  const [seen, setSeen] = createSignal(context() === "files")
  const limit = createMemo(() => maxPaneWidthForWorkspace(workspace(), persistentSidebar()))
  const paneWidth = createMemo(() => paneWidthForWorkspace(width(), workspace(), persistentSidebar()))
  const drag = { start: null as { x: number; width: number } | null }
  const frame: {
    observer?: ResizeObserver
    mutation?: MutationObserver
    pane?: HTMLElement
    sidebar?: HTMLElement
  } = {}
  const browser = () => context() === "files" && !uiStore.file() && !uiStore.saved()
  const fileTabs = createMemo(() =>
    uiStore.workTabs().filter((tab): tab is Extract<WorkTab, { kind: "file" }> => tab.kind === "file"),
  )
  const terminal = () => uiStore.workTabs().some((tab) => tab.kind === "view" && tab.context === "terminal")
  const [terminalSeen, setTerminalSeen] = createSignal(terminal())
  createEffect(() => {
    if (terminal()) setTerminalSeen(true)
  })
  const terminalVisible = () => uiStore.rightPaneOpen() && terminal() && context() === "terminal"
  const selectedFile = (tab: Extract<WorkTab, { kind: "file" }>) => {
    const current = uiStore.file()
    return (
      current?.directory === tab.file.directory && current.path === tab.file.path && current.scope === tab.file.scope
    )
  }
  const visibleFile = (tab: Extract<WorkTab, { kind: "file" }>) =>
    context() === "files" && uiStore.activeWorkTab() === tab.id
  const markDirty = (id: string, dirty: boolean) =>
    setDirtyFiles((items) => (dirty ? [...new Set([...items, id])] : items.filter((item) => item !== id)))
  const openDirty = () => dirtyFiles().filter((id) => fileTabs().some((tab) => tab.id === id))
  const closeWorkTab = async (id?: string) => {
    const target = uiStore.workTabs().find((tab) => tab.id === (id ?? uiStore.activeWorkTab()))
    if (target?.kind === "file" && openDirty().includes(target.id)) {
      const confirmed = await confirmDialog(dialog, {
        title: "Discard unsaved changes?",
        message: `${target.file.name} has changes that have not been saved.`,
        confirmLabel: "Discard and close",
        danger: true,
      })
      if (!confirmed) return
      markDirty(target.id, false)
    }
    if (target?.kind === "file") discardFileDraft(target.file.directory, target.file.path, target.file.scope)
    uiStore.closeWorkTab(id)
  }
  const closePane = async () => {
    const pending = openDirty()
    if (pending.length > 0) {
      const confirmed = await confirmDialog(dialog, {
        title: "Close with unsaved changes?",
        message: `${pending.length} ${pending.length === 1 ? "file has" : "files have"} changes that have not been saved.`,
        confirmLabel: "Discard and close",
        danger: true,
      })
      if (!confirmed) return
      setDirtyFiles([])
    }
    for (const id of pending) {
      const tab = fileTabs().find((item) => item.id === id)
      if (tab) discardFileDraft(tab.file.directory, tab.file.path, tab.file.scope)
      uiStore.closeWorkTab(id)
    }
    uiStore.closeContext()
  }

  createEffect(on(key, () => setWidth(initial())))
  createEffect(() => {
    if (context() === "files") setSeen(true)
  })

  onMount(() => {
    const resize = () => {
      setNarrow(window.innerWidth < INLINE_PANE_BREAKPOINT)
      if (!frame.pane?.parentElement) setWorkspace(window.innerWidth)
    }
    window.addEventListener("resize", resize)
    onCleanup(() => {
      window.removeEventListener("resize", resize)
      frame.observer?.disconnect()
      frame.mutation?.disconnect()
    })
  })

  const observePane = (element: HTMLElement, retry = true) => {
    frame.observer?.disconnect()
    frame.mutation?.disconnect()
    frame.pane = element
    frame.sidebar = undefined
    const boundary = element.closest<HTMLElement>(".project-workspace-frame")
    if (!boundary) {
      if (retry && !element.isConnected) queueMicrotask(() => frame.pane === element && observePane(element, false))
      return
    }
    // Clamp against the complete project frame, but reserve the persistent
    // navigation rail before assigning space to conversation and inspector.
    // Observing the rail keeps the 420px conversation floor intact throughout
    // both collapse/expand transitions and manual sidebar resizing.
    const measure = () => {
      setWorkspace(boundary.clientWidth || window.innerWidth)
      setPersistentSidebar(frame.sidebar?.getBoundingClientRect().width || frame.sidebar?.clientWidth || 0)
    }
    const attachSidebar = () => {
      const next = boundary.querySelector<HTMLElement>(".project-workspace-frame__route .session-sidebar")
      if (frame.sidebar === next) {
        measure()
        return
      }
      if (frame.sidebar) frame.observer?.unobserve(frame.sidebar)
      frame.sidebar = next ?? undefined
      if (frame.sidebar) frame.observer?.observe(frame.sidebar)
      measure()
    }
    if (typeof ResizeObserver !== "undefined") {
      frame.observer = new ResizeObserver(measure)
      frame.observer.observe(boundary)
    }
    if (typeof MutationObserver !== "undefined") {
      frame.mutation = new MutationObserver(attachSidebar)
      frame.mutation.observe(boundary, { childList: true, subtree: true })
    }
    attachSidebar()
  }

  const onHandlePointerDown = (event: PointerEvent) => {
    drag.start = { x: event.clientX, width: paneWidth() }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    document.body.style.cursor = "ew-resize"
    event.preventDefault()
  }
  const onHandlePointerMove = (event: PointerEvent) => {
    if (!drag.start) return
    const next = clampPaneWidth(drag.start.width + (drag.start.x - event.clientX), limit())
    setWidth(next)
  }
  const onHandlePointerUp = (event: PointerEvent) => {
    if (!drag.start) return
    drag.start = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
    document.body.style.cursor = ""
    try {
      savePaneWidth(key(), width())
    } catch {}
  }
  const onHandleKeyDown = (event: KeyboardEvent) => {
    const delta = event.key === "ArrowLeft" ? RESIZE_STEP : event.key === "ArrowRight" ? -RESIZE_STEP : 0
    if (!delta) return
    event.preventDefault()
    const next = clampPaneWidth(paneWidth() + delta, limit())
    setWidth(next)
    try {
      savePaneWidth(key(), next)
    } catch {}
  }
  const splitEvenly = () => {
    const next = equalPaneWidth(workspace(), persistentSidebar())
    setWidth(next)
    try {
      savePaneWidth(key(), next)
    } catch {}
  }

  return (
    <RightPaneGate>
      <RightPaneFrame
        modal={uiStore.rightPaneOpen() && (narrow() || expanded())}
        mobile={uiStore.rightPaneOpen() && narrow()}
        stacked={false}
        expanded={expanded()}
        width={paneWidth()}
        onClose={() => (expanded() ? setExpanded(false) : void closePane())}
        onPane={observePane}
      >
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize research inspector"
            aria-valuemin={MIN_PANE_WIDTH}
            aria-valuemax={limit()}
            aria-valuenow={paneWidth()}
            tabindex={narrow() ? -1 : 0}
            onKeyDown={onHandleKeyDown}
            on:pointerdown={onHandlePointerDown}
            on:pointermove={onHandlePointerMove}
            on:pointerup={onHandlePointerUp}
            on:pointercancel={onHandlePointerUp}
            onDblClick={splitEvenly}
            title="Drag to resize. Double-click to split evenly."
            aria-hidden={narrow() ? "true" : undefined}
            hidden={narrow() || expanded()}
            class="research-inspector__resize"
          />
          <div class="research-inspector__header">
            <Show
              when={uiStore.workTabs().length > 0}
              fallback={
                <div class="research-inspector__context">
                  <strong>{labels[context()]}</strong>
                </div>
              }
            >
              <WorkTabStrip
                tabs={uiStore.workTabs()}
                active={uiStore.activeWorkTab()}
                onSelect={uiStore.activateWorkTab}
                onClose={(id) => void closeWorkTab(id)}
                onReorder={uiStore.moveWorkTab}
              />
            </Show>
            <div class="research-inspector__controls">
              <Show when={!narrow() && !expanded()}>
                <button
                  type="button"
                  class="research-inspector__control"
                  onClick={splitEvenly}
                  title="Split workspace evenly"
                  aria-label="Split workspace evenly"
                >
                  <IconSplit size={16} strokeWidth={1.45} />
                </button>
              </Show>
              <Show when={!narrow()}>
                <button
                  type="button"
                  class="research-inspector__control"
                  onClick={() => setExpanded((value) => !value)}
                  title={expanded() ? "Restore inspector" : "Open inspector full screen"}
                  aria-label={expanded() ? "Restore inspector" : "Open inspector full screen"}
                >
                  <Show when={expanded()} fallback={<IconExpand size={16} strokeWidth={1.55} />}>
                    <IconCollapse size={16} strokeWidth={1.55} />
                  </Show>
                </button>
              </Show>
              <button
                type="button"
                class="research-inspector__control"
                onClick={() => (narrow() ? void closePane() : void closeWorkTab())}
                title={narrow() ? "Back to conversation" : "Close context"}
                aria-label={narrow() ? "Back to conversation" : "Close context"}
                data-modal-initial-focus
              >
                <Show when={narrow()} fallback={<IconX size={17} strokeWidth={1.6} />}>
                  <IconChevronLeft size={17} strokeWidth={1.6} />
                </Show>
              </button>
            </div>
          </div>
          <Suspense fallback={<InspectorLoading label={labels[context()]} />}>
            <For each={fileTabs()}>
              {(tab) => (
                <div
                  aria-hidden={visibleFile(tab) ? undefined : "true"}
                  hidden={!visibleFile(tab)}
                  style={{
                    flex: 1,
                    "min-height": 0,
                    "min-width": 0,
                    display: visibleFile(tab) ? "flex" : "none",
                    "flex-direction": "column",
                  }}
                >
                  <Show
                    when={!tab.file.external}
                    fallback={
                      <ExternalFileAccess
                        file={tab.file}
                        active={selectedFile(tab) && (context() === "files" || context() === "artifact")}
                        onClose={() => void closeWorkTab(tab.id)}
                      />
                    }
                  >
                    <FileView
                      directory={tab.file.directory}
                      path={tab.file.path}
                      scope={tab.file.scope ?? "project"}
                      sessionID={session() === "new" ? undefined : session()}
                      subtitle={
                        tab.file.scope === "auto"
                          ? undefined
                          : tab.file.scope === "session" || tab.file.external
                            ? "Session files"
                            : "Project files"
                      }
                      active={selectedFile(tab) && (context() === "files" || context() === "artifact")}
                      onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                    />
                  </Show>
                </div>
              )}
            </For>
            <Show when={seen()}>
              <div
                data-component="files-context"
                aria-hidden={browser() ? undefined : "true"}
                style={{
                  flex: 1,
                  "min-height": 0,
                  "min-width": 0,
                  display: browser() ? "flex" : "none",
                  "flex-direction": "column",
                }}
              >
                <FilesPane />
              </div>
            </Show>
            <Show when={terminalSeen()}>
              <div
                data-component="terminal-context"
                aria-hidden={terminalVisible() ? undefined : "true"}
                hidden={!terminalVisible()}
                style={{
                  flex: 1,
                  "min-height": 0,
                  "min-width": 0,
                  display: terminalVisible() ? "flex" : "none",
                  "flex-direction": "column",
                }}
              >
                <TerminalSurface active={terminalVisible()} />
              </div>
            </Show>
            <Switch>
              <Match when={context() === "artifact" && artifact()}>
                {(current) => <ArtifactInspector context={current()} />}
              </Match>
              <Match when={context() === "files" && uiStore.saved()}>
                {(current) => <StoredArtifactView artifact={current()} />}
              </Match>
              <Match when={context() === "canvas"}>
                <AtlasCanvas />
              </Match>
              <Match when={context() === "kernels"}>
                <ComputeSurface />
              </Match>
              <Match when={context() === "trace"}>
                <SessionTraceSurface session={session()} />
              </Match>
            </Switch>
          </Suspense>
        </>
      </RightPaneFrame>
    </RightPaneGate>
  )
}

const WORK_TAB_DRAG = "text/openscience-work-tab"

function workTabLabel(tab: WorkTab) {
  if (tab.kind === "file") return tab.file.name
  if (tab.kind === "saved") return tab.artifact.title
  return labels[tab.context]
}

function workTabIcon(tab: WorkTab): JSX.Element {
  if (tab.kind === "saved") return <IconArchive size={16} strokeWidth={1.5} />
  if (tab.kind === "file")
    return <FileIcon node={{ path: tab.file.name, type: "file" }} class="right-pane-file-icon" aria-hidden="true" />
  if (tab.context === "files") return <IconFolder size={16} strokeWidth={1.5} />
  if (tab.context === "terminal") return <IconTerminal size={16} strokeWidth={1.5} />
  if (tab.context === "kernels") return <IconCpu size={16} strokeWidth={1.5} />
  if (tab.context === "canvas") return <IconNetwork size={16} strokeWidth={1.5} />
  if (tab.context === "trace") return <IconActivity size={16} strokeWidth={1.5} />
  return <IconArtifact size={16} strokeWidth={1.5} />
}

function WorkTabStrip(props: {
  tabs: WorkTab[]
  active: string | undefined
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (id: string, to: number) => void
}): JSX.Element {
  let strip: HTMLElement | undefined

  createEffect(() => {
    const active = props.active
    if (!active) return
    queueMicrotask(() =>
      Array.from(strip?.querySelectorAll<HTMLElement>("[data-work-tab]") ?? [])
        .find((item) => item.dataset.workTab === active)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    )
  })

  return (
    <nav
      ref={strip}
      class="inspector-tabs"
      aria-label="Contextual work tabs"
      role="tablist"
      aria-orientation="horizontal"
    >
      <For each={props.tabs}>
        {(tab, index) => (
          <div
            class="inspector-tab-pair"
            title={tab.kind === "file" ? tab.file.path : tab.kind === "saved" ? tab.artifact.title : workTabLabel(tab)}
            data-active={props.active === tab.id ? "true" : undefined}
            role="presentation"
          >
            <button
              type="button"
              class="inspector-tab"
              role="tab"
              data-work-tab={tab.id}
              tabindex={props.active === tab.id ? 0 : -1}
              aria-selected={props.active === tab.id}
              data-active={props.active === tab.id ? "true" : undefined}
              draggable="true"
              onDragStart={(event) => {
                event.dataTransfer?.setData(WORK_TAB_DRAG, tab.id)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
              }}
              onDragOver={(event) => {
                if (event.dataTransfer?.types.includes(WORK_TAB_DRAG)) event.preventDefault()
              }}
              onDrop={(event) => {
                const dragged = event.dataTransfer?.getData(WORK_TAB_DRAG)
                if (!dragged || dragged === tab.id) return
                event.preventDefault()
                props.onReorder(dragged, index())
              }}
              onClick={() => props.onSelect(tab.id)}
              onKeyDown={(event) => {
                if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                  event.preventDefault()
                  props.onReorder(tab.id, index() + (event.key === "ArrowRight" ? 1 : -1))
                  return
                }
                const target =
                  event.key === "Home"
                    ? props.tabs[0]
                    : event.key === "End"
                      ? props.tabs.at(-1)
                      : event.key === "ArrowLeft"
                        ? props.tabs[(index() - 1 + props.tabs.length) % props.tabs.length]
                        : event.key === "ArrowRight"
                          ? props.tabs[(index() + 1) % props.tabs.length]
                          : undefined
                if (!target) return
                event.preventDefault()
                const owner = event.currentTarget.closest(".inspector-tabs")
                props.onSelect(target.id)
                queueMicrotask(() =>
                  Array.from(owner?.querySelectorAll<HTMLElement>("[data-work-tab]") ?? [])
                    .find((item) => item.dataset.workTab === target.id)
                    ?.focus(),
                )
              }}
            >
              <span class="inspector-tab__icon" aria-hidden="true">
                {workTabIcon(tab)}
              </span>
              <span class="inspector-tab__name">{workTabLabel(tab)}</span>
            </button>
            <button
              type="button"
              class="inspector-tab__close"
              aria-label={`Close ${workTabLabel(tab)}`}
              onClick={() => props.onClose(tab.id)}
            >
              <IconX size={11} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </For>
    </nav>
  )
}

function InspectorLoading(props: { label: string }): JSX.Element {
  return (
    <div
      data-component="inspector-loading"
      style={{ flex: 1, display: "flex", "align-items": "center", "justify-content": "center" }}
    >
      <AsciiSpinner size={10} label={`Loading ${props.label.toLowerCase()}…`} color="var(--color-text-faint)" />
    </div>
  )
}
