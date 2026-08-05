import { For, type JSX } from "solid-js"
import { middle } from "@/atlas/files/truncate"

export function FileTabs(props: {
  open: string[]
  /** The open file the pane is showing, or undefined for the browser itself. */
  active?: string
  onSelect: (id?: string) => void
  onClose: (id: string) => void
}): JSX.Element {
  return (
    <div class="files-tabs" role="tablist" aria-label="Open files">
      <button
        type="button"
        class="files-tab files-tab--home"
        role="tab"
        data-tab="files"
        aria-selected={props.active === undefined}
        onClick={() => props.onSelect(undefined)}
      >
        <span class="files-tab__label" data-tab-label>
          Files
        </span>
      </button>

      <For each={props.open}>
        {(name) => (
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
              onClick={() => props.onSelect(name)}
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
  )
}
