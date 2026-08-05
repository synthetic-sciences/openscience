import { For, Show, createSignal, type JSX } from "solid-js"
import { groupSources, type PaneSource } from "@/atlas/files/sources"

export function SourceMenu(props: {
  sources: PaneSource[]
  active: PaneSource
  onPick: (source: PaneSource) => void
  onAdd?: () => void
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const pick = (source: PaneSource) => {
    setOpen(false)
    props.onPick(source)
  }

  return (
    <div class="files-source">
      <button
        type="button"
        class="files-source__button"
        data-source-button
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <span class="files-source__name">{props.active.name}</span>
        <span class="files-source__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      <Show when={open()}>
        <div class="files-menu-wrap">
          <button
            type="button"
            class="files-menu__scrim"
            aria-label="Close source menu"
            onClick={() => setOpen(false)}
          />
          <div class="files-menu" data-source-menu role="menu">
            <For each={groupSources(props.sources)}>
              {(group) => (
                <>
                  <div class="files-menu__group" data-source-group>
                    {group.group}
                  </div>
                  <For each={group.items}>
                    {(source) => (
                      <button
                        type="button"
                        class="files-menu__item"
                        role="menuitemradio"
                        data-source-item={source.id}
                        aria-checked={source === props.active}
                        onClick={() => pick(source)}
                      >
                        <span class="files-menu__glyph" aria-hidden="true">
                          {source.kind === "artifacts"
                            ? "◈"
                            : source.kind === "trash"
                              ? "◌"
                              : source.kind === "connected"
                                ? "◇"
                                : "▢"}
                        </span>
                        <span>
                          <span class="files-menu__label">{source.name}</span>
                          <Show when={source.sub}>
                            <span class="files-menu__sub">{source.sub}</span>
                          </Show>
                        </span>
                        <span class="files-menu__tail">
                          <Show when={source.readonly}>
                            <span class="files-menu__badge">ro</span>
                          </Show>
                          <Show when={source.live}>
                            <span class="files-menu__dot" aria-label="Reachable" />
                          </Show>
                          <Show when={source === props.active}>
                            <span aria-hidden="true">✓</span>
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
            <Show when={props.onAdd}>
              <div class="files-menu__sep" />
              <button type="button" class="files-menu__item" onClick={() => { setOpen(false); props.onAdd?.() }}>
                <span class="files-menu__glyph" aria-hidden="true">+</span>
                <span><span class="files-menu__label">Add folder…</span></span>
                <span class="files-menu__tail" />
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
