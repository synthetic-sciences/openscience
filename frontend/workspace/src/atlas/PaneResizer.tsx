import { createEffect, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { clampPaneWidth, MIN_PANE_WIDTH } from "./right-pane-layout"

const STEP = 16

/** A captured drag stays above embedded previews without changing the global cursor. */
export function PaneResizer(props: {
  owner: string
  controls?: string
  label?: string
  title?: string
  class?: string
  edge?: "left" | "right"
  disabled: boolean
  width: number
  preferredWidth?: number
  min?: number
  max: number
  onResize: (width: number) => void
  onCommit: (width: number) => void
  onReset: () => void
}) {
  const [state, setState] = createStore({ dragging: false })
  const drag: { finish?: (commit?: boolean, revert?: boolean) => void } = {}
  createEffect(() => {
    props.owner
    props.disabled
    untrack(() => drag.finish?.(false))
  })
  onCleanup(() => drag.finish?.(false))

  const start = (event: PointerEvent) => {
    if (props.disabled || event.button !== 0 || !event.isPrimary || drag.finish) return
    const handle = event.currentTarget as HTMLElement
    const doc = handle.ownerDocument
    const win = doc.defaultView
    if (!win) return
    const owner = props.owner
    const width = props.width
    const preferred = props.preferredWidth ?? width
    const x = event.clientX
    const direction = props.edge === "right" ? 1 : -1
    const shield = doc.createElement("div")
    shield.setAttribute("data-pane-resize-shield", "")
    shield.setAttribute("aria-hidden", "true")
    // Inline styling is intentional: the shield must also cover iframe browsing
    // contexts, even when capture is unavailable in the host WebView.
    Object.assign(shield.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "ew-resize",
      touchAction: "none",
      userSelect: "none",
    })
    doc.body.append(shield)
    const current = { width }
    const finish = (commit = true, revert = false) => {
      if (drag.finish !== finish) return
      drag.finish = undefined
      win.removeEventListener("pointermove", move, true)
      win.removeEventListener("pointerup", end, true)
      win.removeEventListener("pointercancel", end, true)
      win.removeEventListener("blur", blur)
      doc.removeEventListener("visibilitychange", visibility)
      doc.removeEventListener("keydown", keydown, true)
      handle.removeEventListener("lostpointercapture", lost)
      shield.remove()
      setState("dragging", false)
      // Some WebViews release capture before pointerup, or throw on a detached
      // handle. Cleanup must finish before attempting this best-effort release.
      try {
        if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      } catch {}
      if (props.owner !== owner || props.disabled) return
      if (revert) props.onResize(preferred)
      if (commit) props.onCommit(current.width)
    }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return
      if (props.owner !== owner || props.disabled) return finish(false)
      if (next.pointerType === "mouse" && next.buttons === 0) return finish()
      current.width = clampPaneWidth(width + (next.clientX - x) * direction, props.max, props.min)
      props.onResize(current.width)
      next.preventDefault()
    }
    const end = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) finish()
    }
    const lost = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) finish()
    }
    const blur = () => finish()
    const visibility = () => {
      if (doc.visibilityState === "hidden") finish()
    }
    const keydown = (next: KeyboardEvent) => {
      if (next.key !== "Escape") return
      next.preventDefault()
      next.stopPropagation()
      finish(false, true)
    }
    drag.finish = finish
    win.addEventListener("pointermove", move, { capture: true, passive: false })
    win.addEventListener("pointerup", end, true)
    win.addEventListener("pointercancel", end, true)
    win.addEventListener("blur", blur)
    doc.addEventListener("visibilitychange", visibility)
    doc.addEventListener("keydown", keydown, true)
    handle.addEventListener("lostpointercapture", lost)
    setState("dragging", true)
    try {
      handle.setPointerCapture?.(event.pointerId)
    } catch {}
    event.preventDefault()
  }

  const keydown = (event: KeyboardEvent) => {
    if (props.disabled || drag.finish || event.altKey || event.ctrlKey || event.metaKey) return
    const step = event.shiftKey ? STEP * 4 : STEP
    const direction = props.edge === "right" ? -1 : 1
    const next =
      event.key === "ArrowLeft"
        ? props.width + step * direction
        : event.key === "ArrowRight"
          ? props.width - step * direction
          : event.key === "Home"
            ? (props.min ?? MIN_PANE_WIDTH)
            : event.key === "End"
              ? props.max
              : undefined
    if (next === undefined) return
    event.preventDefault()
    const width = clampPaneWidth(next, props.max, props.min)
    props.onResize(width)
    props.onCommit(width)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label ?? "Resize research inspector"}
      aria-controls={props.controls}
      aria-valuemin={props.min ?? MIN_PANE_WIDTH}
      aria-valuemax={props.max}
      aria-valuenow={props.width}
      aria-valuetext={`${Math.round(props.width)} pixels`}
      tabindex={props.disabled ? -1 : 0}
      onKeyDown={keydown}
      on:pointerdown={start}
      onDblClick={() => !props.disabled && props.onReset()}
      title={
        props.title ??
        "Drag or use arrow keys to resize. Shift resizes faster. Home/End sets the minimum/maximum. Double-click for equal split. Escape cancels a drag."
      }
      aria-hidden={props.disabled ? "true" : undefined}
      hidden={props.disabled}
      data-dragging={state.dragging ? "true" : undefined}
      class={props.class ?? "research-inspector__resize"}
    />
  )
}
