import { For, Show, createSignal, type JSX } from "solid-js"
import { groupSources, type PaneSource } from "@/atlas/files/sources"
import { IconArchive, IconCloud, IconFolder, IconFolderAdd, IconLink, IconTrash } from "@/atlas/shared/Icon"

/**
 * One icon per kind of place files come from. A connected folder is drawn as a
 * link rather than a folder because that is what distinguishes it from the
 * project's own tree, and a provider is drawn as a cloud because its files are
 * not on this machine at all.
 */
const glyph = (kind: PaneSource["kind"]) => {
  if (kind === "artifacts") return IconArchive
  if (kind === "trash") return IconTrash
  if (kind === "connected") return IconLink
  if (kind === "modal") return IconCloud
  return IconFolder
}

export function SourceMenu(props: {
  sources: PaneSource[]
  active: PaneSource
  onPick: (source: PaneSource) => void
  onAdd?: () => void
  onRevoke?: (source: PaneSource) => void
  /**
   * Called the first time the menu is opened. Listing Modal Volumes is a call
   * to Modal's API, so it is paid when someone looks for a source rather than
   * on every mount of the pane.
   */
  onOpen?: () => void
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const pick = (source: PaneSource) => {
    setOpen(false)
    props.onPick(source)
  }
  const revoke = (source: PaneSource) => {
    setOpen(false)
    props.onRevoke?.(source)
  }

  return (
    <div class="files-source">
      <button
        type="button"
        class="files-source__button"
        data-source-button
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => {
          if (!open()) props.onOpen?.()
          setOpen(!open())
        }}
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
                      // The row is a presentational container, not a control:
                      // picking a source and revoking it are two separate
                      // actions, so they are two sibling <button>s. Nesting the
                      // revoke control inside the row button (as a role="button"
                      // span) was invalid content and folded its label into the
                      // row's accessible name — "pdebench … Revoke access to
                      // pdebench" announced as one control.
                      <div class="files-menu__row" role="none">
                        <button
                          type="button"
                          class="files-menu__item"
                          role="menuitemradio"
                          data-source-item={source.id}
                          aria-checked={source === props.active}
                          onClick={() => pick(source)}
                        >
                          <span class="files-menu__glyph" aria-hidden="true">
                            {glyph(source.kind)({ size: 15, strokeWidth: 1.5 })}
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
                        {/* A connected folder is a durable grant, so the way out
                            sits on the row that shows it. */}
                        <Show when={source.kind === "connected" && props.onRevoke}>
                          <button
                            type="button"
                            class="files-menu__revoke"
                            role="menuitem"
                            data-source-revoke={source.id}
                            aria-label={`Revoke access to ${source.name}`}
                            onClick={() => revoke(source)}
                          >
                            Revoke
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
            <Show when={props.onAdd}>
              <div class="files-menu__sep" />
              <button
                type="button"
                class="files-menu__item"
                data-source-add
                onClick={() => {
                  setOpen(false)
                  props.onAdd?.()
                }}
              >
                <span class="files-menu__glyph" aria-hidden="true">
                  <IconFolderAdd size={15} strokeWidth={1.5} />
                </span>
                <span>
                  <span class="files-menu__label">Add folder…</span>
                </span>
                <span class="files-menu__tail" />
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
