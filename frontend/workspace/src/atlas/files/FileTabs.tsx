import { For, Show, type JSX } from "solid-js"
import { middle } from "@/atlas/files/truncate"

const DRAG = "text/openscience-file-tab"

export function FileTabs(props: {
  open: string[]
  /** The open file the pane is showing, or undefined while browsing. */
  active?: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder?: (id: string, to: number) => void
}): JSX.Element {
  return (
    <Show when={props.open.length > 0}>
      <div class="files-tabs" role="tablist" aria-label="Open files">
        <For each={props.open}>
          {(name, index) => (
            // Two sibling controls, one row: selecting a tab and closing it are
            // separate actions, so neither may contain the other. A close control
            // nested in the tab button (a role="button" span) was invalid content
            // and folded its label into the tab's accessible name — "train_lr.py
            // Close train_lr.py" announced as one control. Same shape as
            // SourceMenu's row.
            <div class="files-tab-pair" classList={{ "files-tab-pair--active": props.active === name }} role="none">
              <button
                type="button"
                class="files-tab"
                role="tab"
                data-tab={name}
                aria-selected={props.active === name}
                title={name}
                draggable="true"
                onClick={() => props.onSelect(name)}
                onDragStart={(event) => {
                  event.dataTransfer?.setData(DRAG, name)
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer?.types.includes(DRAG)) event.preventDefault()
                }}
                onDrop={(event) => {
                  const dragged = event.dataTransfer?.getData(DRAG)
                  if (!dragged || dragged === name) return
                  event.preventDefault()
                  props.onReorder?.(dragged, index())
                }}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
                  event.preventDefault()
                  props.onReorder?.(name, index() + (event.key === "ArrowRight" ? 1 : -1))
                }}
              >
                <span class="files-tab__label" data-tab-label>
                  {middle(name, 22)}
                </span>
              </button>
              <button
                type="button"
                class="files-tab__close"
                data-tab-close={name}
                aria-label={`Close ${name}`}
                onClick={() => props.onClose(name)}
              >
                ✕
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
