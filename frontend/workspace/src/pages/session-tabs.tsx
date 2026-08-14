import { createEffect, createUniqueId, For, on, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { IconX } from "@/atlas/shared/Icon"
import { StatusDot } from "@/atlas/shared/StatusDot"
import { sessionTabTarget } from "@/pages/session-tab-navigation"
import "./session-tabs.css"

export interface SessionTabItem {
  id: string
  title: string
  working: boolean
  dirty: boolean
  unread: boolean
  editable?: boolean
  closable?: boolean
  reorderable?: boolean
}

export function sessionTabID(id: string) {
  return `workspace-session-tab-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

const DRAG_TYPE = "text/openscience-session-tab"

export function SessionTabStrip(props: {
  tabs: SessionTabItem[]
  active: string
  onSelect: (id: string) => void
  onClose: (id: string) => string | undefined | void
  onReorder: (id: string, to: number) => void
  onRename: (id: string, title: string) => Promise<boolean>
  onWarm?: (id: string) => void
}): JSX.Element {
  const inputID = createUniqueId()
  const statusID = `${inputID}-status`
  const [state, setState] = createStore({
    editing: "",
    draft: "",
    saving: false,
    error: "",
    left: 0,
    top: 5,
    width: 180,
  })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let pendingFocus = ""

  const buttons = () => Array.from(root?.querySelectorAll<HTMLButtonElement>("[data-session-tab]") ?? [])
  const button = (id: string) => buttons().find((item) => item.dataset.sessionTab === id)
  const focus = (id: string) => queueMicrotask(() => button(id)?.focus())
  const clear = () =>
    setState({
      editing: "",
      draft: "",
      saving: false,
      error: "",
      left: 0,
      top: 5,
      width: 180,
    })

  const start = (item: SessionTabItem, target: HTMLElement) => {
    if (item.id !== props.active || item.editable === false || state.saving) return
    const pair = target.closest<HTMLElement>(".workspace-session-tab")
    const bounds = root?.getBoundingClientRect()
    const rect = pair?.getBoundingClientRect()
    setState({
      editing: item.id,
      draft: item.title,
      saving: false,
      error: "",
      left: rect && bounds ? Math.max(0, rect.left - bounds.left) : 0,
      top: rect && bounds ? Math.max(0, rect.top - bounds.top) : 5,
      width: Math.max(152, rect?.width ?? 180),
    })
    queueMicrotask(() => {
      input?.focus()
      input?.select()
    })
  }

  const commit = async (source: "keyboard" | "blur") => {
    const id = state.editing
    if (!id || state.saving) return
    const current = props.tabs.find((item) => item.id === id)
    if (!current) {
      clear()
      return
    }
    const title = state.draft.trim()
    if (!title) {
      if (source === "blur") {
        clear()
        focus(id)
        return
      }
      setState("error", "Enter a session name.")
      queueMicrotask(() => input?.focus())
      return
    }
    if (title === current.title) {
      clear()
      focus(id)
      return
    }

    setState({ saving: true, error: "" })
    const saved = await props.onRename(id, title)
    if (state.editing !== id) return
    setState("saving", false)
    if (saved) {
      clear()
      focus(id)
      return
    }
    setState("error", "Could not save the session name. Try again.")
    if (source === "keyboard") {
      queueMicrotask(() => {
        input?.focus()
        input?.select()
      })
    }
  }

  createEffect(
    on(
      () => props.active,
      (active) => {
        if (state.editing && state.editing !== active) clear()
        queueMicrotask(() => {
          const target = button(active)
          target?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
          // Selecting a tab can remount the session route. A focus scheduled
          // before navigation then lands on the removed button, so complete
          // keyboard focus restoration only after the new active tab exists.
          if (pendingFocus !== active) return
          pendingFocus = ""
          target?.focus()
        })
      },
    ),
  )

  return (
    <div ref={root} class="workspace-session-tabs">
      <nav class="workspace-tabs" aria-label="Open sessions">
        <div class="workspace-tabs__list" role="tablist" aria-orientation="horizontal">
          <For each={props.tabs}>
            {(item, index) => {
              const active = () => props.active === item.id
              const stateLabel = () =>
                [item.working ? "working" : "", item.unread ? "unread" : "", item.dirty ? "draft saved" : ""]
                  .filter(Boolean)
                  .join(", ")
              return (
                <div
                  class="workspace-session-tab"
                  role="presentation"
                  data-active={active() ? "true" : undefined}
                  data-working={item.working ? "true" : undefined}
                  data-unread={item.unread ? "true" : undefined}
                  data-dirty={item.dirty ? "true" : undefined}
                  title={active() && item.editable !== false ? "Double-click to rename" : item.title}
                >
                  <button
                    type="button"
                    id={sessionTabID(item.id)}
                    class="workspace-tab"
                    role="tab"
                    data-session-tab={item.id}
                    tabindex={active() ? 0 : -1}
                    aria-selected={active()}
                    aria-controls="session-conversation-panel"
                    aria-keyshortcuts={active() && item.editable !== false ? "F2" : undefined}
                    aria-label={`${item.title}${stateLabel() ? `, ${stateLabel()}` : ""}${
                      active() && item.editable !== false ? ". Press F2 to rename" : ""
                    }`}
                    draggable={item.reorderable !== false}
                    onPointerEnter={() => props.onWarm?.(item.id)}
                    onFocus={() => props.onWarm?.(item.id)}
                    onDragStart={(event) => {
                      if (item.reorderable === false) {
                        event.preventDefault()
                        return
                      }
                      event.dataTransfer?.setData(DRAG_TYPE, item.id)
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                    }}
                    onDragOver={(event) => {
                      if (event.dataTransfer?.types.includes(DRAG_TYPE)) event.preventDefault()
                    }}
                    onDrop={(event) => {
                      const dragged = event.dataTransfer?.getData(DRAG_TYPE)
                      if (!dragged || dragged === item.id) return
                      event.preventDefault()
                      props.onReorder(dragged, index())
                    }}
                    onClick={() => props.onSelect(item.id)}
                    onDblClick={(event) => start(item, event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault()
                        start(item, event.currentTarget)
                        return
                      }
                      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                        event.preventDefault()
                        if (item.reorderable === false) return
                        props.onReorder(item.id, index() + (event.key === "ArrowRight" ? 1 : -1))
                        return
                      }
                      const target = sessionTabTarget(event.key, index(), props.tabs.length)
                      if (target === undefined) return
                      event.preventDefault()
                      const next = props.tabs[target]
                      pendingFocus = next.id
                      props.onSelect(next.id)
                      focus(next.id)
                    }}
                  >
                    <Show when={item.working || item.unread}>
                      <span class="workspace-tab__status" aria-hidden="true">
                        <StatusDot status={item.working ? "active" : "pending"} size={6} />
                      </span>
                    </Show>
                    <span class="workspace-tab__name">{item.title}</span>
                    <Show when={item.dirty}>
                      <span class="workspace-tab__dirty" aria-hidden="true">
                        •
                      </span>
                    </Show>
                  </button>
                  <Show when={item.closable !== false}>
                    <button
                      type="button"
                      class="workspace-tab__close"
                      aria-label={`Close ${item.title}`}
                      onClick={(event) => {
                        if (state.editing === item.id) clear()
                        const restoreFocus = document.activeElement === event.currentTarget
                        const target = props.onClose(item.id)
                        if (restoreFocus) focus(typeof target === "string" ? target : props.active)
                      }}
                    >
                      <IconX size={11} strokeWidth={1.5} />
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </nav>

      <Show when={state.editing}>
        <div
          class="workspace-tab-editor"
          style={{ left: `${state.left}px`, top: `${state.top}px`, width: `${state.width}px` }}
        >
          <label class="sr-only" for={inputID}>
            Session name
          </label>
          <input
            ref={input}
            id={inputID}
            value={state.draft}
            disabled={state.saving}
            aria-invalid={state.error ? "true" : undefined}
            aria-describedby={statusID}
            onInput={(event) => {
              setState("draft", event.currentTarget.value)
              if (state.error) setState("error", "")
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") {
                event.preventDefault()
                void commit("keyboard")
                return
              }
              if (event.key !== "Escape" || state.saving) return
              event.preventDefault()
              const id = state.editing
              clear()
              focus(id)
            }}
            onBlur={() => void commit("blur")}
            spellcheck={false}
            autocomplete="off"
          />
          <span id={statusID} class="sr-only" role="status" aria-live="polite">
            {state.saving ? "Saving session name…" : state.error}
          </span>
        </div>
      </Show>
    </div>
  )
}
