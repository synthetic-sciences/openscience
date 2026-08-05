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
import { ArtifactInspector } from "@/artifacts/ArtifactInspector"
import { StoredArtifactView } from "@/artifacts/StoredArtifactView"
import { AsciiSpinner } from "@/atlas/shared/AsciiSpinner"
import { IconChevronLeft, IconCollapse, IconExpand, IconX } from "@/atlas/shared/Icon"
import {
  DEFAULT_PANE_WIDTH,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  INLINE_PANE_BREAKPOINT,
  clampPaneWidth,
  paneWidthForViewport,
  paneWidthKey,
  readPaneWidth,
  savePaneWidth,
} from "@/atlas/right-pane-layout"

const RESIZE_STEP = 16
const labels: Record<ContextTab, string> = {
  artifact: "Artifact details",
  files: "Files",
  terminal: "Terminal",
  canvas: "Atlas",
  kernels: "Compute",
  trace: "Trace",
}

export function RightPaneGate(props: { children: JSX.Element }): JSX.Element {
  createEffect(() => uiStore.syncArtifact(Boolean(artifactContext.active())))
  return <Show when={uiStore.rightPaneOpen()}>{props.children}</Show>
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
      (item) => item.getAttribute("aria-hidden") !== "true",
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
        ref={(element) => (refs.pane = element)}
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
    onEnsureSession?: () => Promise<string | undefined>
  } = {},
): JSX.Element {
  const context = uiStore.context
  const artifact = artifactContext.active
  const project = () => props.project ?? props.route ?? window.location.pathname
  const session = () => props.session ?? "new"
  const key = createMemo(() => paneWidthKey(project(), session()))
  const legacy = createMemo(() =>
    props.project && props.session ? [paneWidthKey(`${props.project}/${props.session}`)] : [],
  )
  const initial = () => {
    try {
      return readPaneWidth(key(), localStorage, legacy())
    } catch {
      return DEFAULT_PANE_WIDTH
    }
  }
  const [width, setWidth] = createSignal(initial())
  const [expanded, setExpanded] = createSignal(false)
  const [viewport, setViewport] = createSignal(typeof window === "undefined" ? 1440 : window.innerWidth)
  const [narrow, setNarrow] = createSignal(typeof window !== "undefined" && window.innerWidth < INLINE_PANE_BREAKPOINT)
  const paneWidth = createMemo(() => paneWidthForViewport(width(), viewport()))
  const drag = { start: null as { x: number; width: number } | null }

  createEffect(on(key, () => setWidth(initial())))

  onMount(() => {
    const resize = () => {
      setViewport(window.innerWidth)
      setNarrow(window.innerWidth < INLINE_PANE_BREAKPOINT)
    }
    window.addEventListener("resize", resize)
    onCleanup(() => window.removeEventListener("resize", resize))
  })

  const onHandlePointerDown = (event: PointerEvent) => {
    drag.start = { x: event.clientX, width: paneWidth() }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    document.body.style.cursor = "ew-resize"
    event.preventDefault()
  }
  const onHandlePointerMove = (event: PointerEvent) => {
    if (!drag.start) return
    const next = clampPaneWidth(drag.start.width + (drag.start.x - event.clientX))
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
    const next = clampPaneWidth(paneWidth() + delta)
    setWidth(next)
    try {
      savePaneWidth(key(), next)
    } catch {}
  }

  return (
    <RightPaneGate>
      <RightPaneFrame
        modal={narrow() || expanded()}
        mobile={narrow()}
        stacked={false}
        expanded={expanded()}
        width={paneWidth()}
        onClose={() => (expanded() ? setExpanded(false) : uiStore.closeContext())}
      >
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize research inspector"
            aria-valuemin={MIN_PANE_WIDTH}
            aria-valuemax={MAX_PANE_WIDTH}
            aria-valuenow={paneWidth()}
            tabindex={narrow() ? -1 : 0}
            onKeyDown={onHandleKeyDown}
            on:pointerdown={onHandlePointerDown}
            on:pointermove={onHandlePointerMove}
            on:pointerup={onHandlePointerUp}
            on:pointercancel={onHandlePointerUp}
            aria-hidden={narrow() ? "true" : undefined}
            hidden={expanded()}
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
            onMouseEnter={(event) => (event.currentTarget.style.background = "var(--color-accent-subtle)")}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
          />
          <div class="research-inspector__header">
            <div class="research-inspector__context">
              <span>Research</span>
              <strong>
                {context() === "files" && uiStore.file()
                  ? uiStore.file()!.name
                  : context() === "files" && uiStore.saved()
                    ? uiStore.saved()!.title
                    : labels[context()]}
              </strong>
            </div>
            <div class="research-inspector__controls">
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
                onClick={() => (narrow() ? uiStore.closeContext() : uiStore.closeWorkTab())}
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
          <Show when={uiStore.workTabs().length > 0}>
            <WorkTabStrip
              tabs={uiStore.workTabs()}
              active={uiStore.activeWorkTab()}
              onSelect={uiStore.activateWorkTab}
              onClose={uiStore.closeWorkTab}
              onReorder={uiStore.moveWorkTab}
            />
          </Show>
          <Suspense fallback={<InspectorLoading label={labels[context()]} />}>
            <Show when={uiStore.file()} keyed>
              {(file) => (
                <div
                  aria-hidden={context() === "files" ? undefined : "true"}
                  style={{
                    flex: 1,
                    "min-height": 0,
                    "min-width": 0,
                    display: context() === "files" ? "flex" : "none",
                    "flex-direction": "column",
                  }}
                >
                  <Show
                    when={!file.external}
                    fallback={
                      <ExternalFileAccess
                        file={file}
                        active={context() === "files" || context() === "artifact"}
                        onClose={() => uiStore.closeFile()}
                      />
                    }
                  >
                    <FileView
                      directory={file.directory}
                      path={file.path}
                      subtitle="Session files"
                      active={context() === "files" || context() === "artifact"}
                      onClose={() => uiStore.closeFile()}
                    />
                  </Show>
                </div>
              )}
            </Show>
            <Switch>
              <Match when={context() === "artifact" && artifact()}>
                {(current) => <ArtifactInspector context={current()} />}
              </Match>
              <Match when={context() === "files" && uiStore.saved()}>
                {(current) => <StoredArtifactView artifact={current()} />}
              </Match>
              <Match when={context() === "files" && !uiStore.file() && !uiStore.saved()}>
                <FilesPane />
              </Match>
              <Match when={context() === "terminal"}>
                <TerminalSurface />
              </Match>
              <Match when={context() === "canvas"}>
                <AtlasCanvas />
              </Match>
              <Match when={context() === "kernels"}>
                <ComputeSurface onEnsureSession={props.onEnsureSession} />
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

function WorkTabStrip(props: {
  tabs: WorkTab[]
  active: string | undefined
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (id: string, to: number) => void
}): JSX.Element {
  return (
    <nav class="inspector-tabs" aria-label="Contextual work tabs">
      <For each={props.tabs}>
        {(tab, index) => (
          <div
            class="inspector-tab"
            role="tab"
            tabindex={0}
            title={tab.kind === "file" ? tab.file.path : tab.kind === "saved" ? tab.artifact.title : workTabLabel(tab)}
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
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              props.onSelect(tab.id)
            }}
          >
            <span class="inspector-tab__name">{workTabLabel(tab)}</span>
            <button
              type="button"
              class="inspector-tab__close"
              aria-label={`Close ${workTabLabel(tab)}`}
              onClick={(event) => {
                event.stopPropagation()
                props.onClose(tab.id)
              }}
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
      <AsciiSpinner size={10} label={`loading ${props.label.toLowerCase()}…`} color="var(--color-text-faint)" />
    </div>
  )
}
