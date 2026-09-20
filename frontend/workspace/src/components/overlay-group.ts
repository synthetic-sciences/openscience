import { createSignal, onCleanup } from "solid-js"

/**
 * One open menu at a time. The composer's menus are four separate things — two
 * native `<details>` and two Kobalte popovers — and each only knew how to close
 * itself, so opening one left the others open on top of each other. A group
 * holds the id of the menu that owns the surface and closes the one it replaces.
 */
export type OverlayGroup = {
  /** The menu that currently owns the group, if any. */
  current: () => string | undefined
  /** Claim the group for `id`, closing whatever else was open. */
  open: (id: string) => void
  /** Release the group if `id` still owns it. */
  close: (id: string) => void
  /** Teach the group how to close `id`; returns the unregister. */
  register: (id: string, close: () => void) => () => void
}

export function createOverlayGroup(): OverlayGroup {
  const [current, setCurrent] = createSignal<string>()
  const closers = new Map<string, () => void>()
  return {
    current,
    open(id) {
      const previous = current()
      if (previous === id) return
      // Claim before closing: the outgoing menu releases its own id as it
      // closes, and that release must not clear the claim just made.
      setCurrent(id)
      if (previous) closers.get(previous)?.()
    },
    close(id) {
      if (current() !== id) return
      setCurrent(undefined)
    },
    register(id, close) {
      closers.set(id, close)
      return () => {
        if (closers.get(id) !== close) return
        closers.delete(id)
        if (current() === id) setCurrent(undefined)
      }
    },
  }
}

/** Join `group` for the lifetime of the calling component. */
export function registerOverlay(group: OverlayGroup, id: string, close: () => void) {
  onCleanup(group.register(id, close))
}

/**
 * Join `group` with a native `<details>` menu. A `<details>` tells nothing else
 * that its summary was clicked and has no dismissal of its own: this reports
 * every `toggle` to the group, and closes the menu when the group hands the
 * surface to another one, on a pointerdown outside it, and on Escape.
 */
export function registerOverlayDetails(group: OverlayGroup, id: string, element: HTMLDetailsElement) {
  const close = () => {
    if (!element.open) return
    element.open = false
  }
  const toggle = () => (element.open ? group.open(id) : group.close(id))
  const pointerdown = (event: PointerEvent) => {
    if (!element.open) return
    if (event.target instanceof Node && element.contains(event.target)) return
    close()
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !element.open) return
    event.preventDefault()
    close()
    element.querySelector("summary")?.focus()
  }
  element.addEventListener("toggle", toggle)
  element.addEventListener("keydown", keydown)
  document.addEventListener("pointerdown", pointerdown)
  registerOverlay(group, id, close)
  onCleanup(() => {
    element.removeEventListener("toggle", toggle)
    element.removeEventListener("keydown", keydown)
    document.removeEventListener("pointerdown", pointerdown)
  })
}

/** The composer footer's menus: Tools, the working folder, model, effort. */
export const composerOverlays = createOverlayGroup()
