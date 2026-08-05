import { For, type JSX } from "solid-js"
import { middle } from "@/atlas/files/truncate"

export function FileTabs(props: {
  open: string[]
  active: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
}): JSX.Element {
  return (
    <div class="files-tabs" role="tablist" aria-label="Open files">
      <button
        type="button"
        class="files-tab"
        role="tab"
        data-tab="files"
        aria-selected={props.active === "files"}
        onClick={() => props.onSelect("files")}
      >
        <span class="files-tab__label" data-tab-label>
          Files
        </span>
      </button>

      <For each={props.open}>
        {(name) => (
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
            <span
              class="files-tab__close"
              role="button"
              tabindex="0"
              data-tab-close={name}
              aria-label={`Close ${name}`}
              onClick={(event) => {
                event.stopPropagation()
                props.onClose(name)
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                event.stopPropagation()
                props.onClose(name)
              }}
            >
              ✕
            </span>
          </button>
        )}
      </For>
    </div>
  )
}
