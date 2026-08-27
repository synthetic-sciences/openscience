import { For, Show, createSignal, type JSX } from "solid-js"
import { groupSources, type PaneSource } from "@/atlas/files/sources"
import {
  IconArchive,
  IconChevronDown,
  IconCloud,
  IconFolder,
  IconFolderAdd,
  IconLink,
  IconMoreH,
  IconTrash,
} from "@/atlas/shared/Icon"
import "./file-items.css"

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
  /** Use a stable label such as “More” when primary locations are separate tabs. */
  triggerLabel?: string
  /**
   * Called the first time the menu is opened. Listing Modal Volumes is a call
   * to Modal's API, so it is paid when someone looks for a source rather than
   * on every mount of the pane.
   */
  onOpen?: () => void
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const refs: { trigger?: HTMLButtonElement; menu?: HTMLDivElement } = {}
  const items = () => Array.from(refs.menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])
  const focusItem = (item: HTMLElement | undefined) => {
    if (!item) return
    items().forEach((candidate) => (candidate.tabIndex = candidate === item ? 0 : -1))
    item.focus()
  }
  const restoreRefreshFocus = (target: EventTarget | null) => {
    const previous = target instanceof HTMLElement ? target : undefined
    const sourceID = previous?.dataset.sourceItem
    const revokeID = previous?.dataset.sourceRevoke
    queueMicrotask(() => {
      const active = document.activeElement
      if (active?.isConnected && active !== document.body) return
      if (!open() || !refs.menu?.isConnected) return
      const replacement = items().find(
        (candidate) =>
          (sourceID !== undefined && candidate.dataset.sourceItem === sourceID) ||
          (revokeID !== undefined && candidate.dataset.sourceRevoke === revokeID),
      )
      focusItem(replacement ?? items()[0])
    })
  }
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus)
      queueMicrotask(() => {
        const active = document.activeElement
        if (active?.isConnected && active !== document.body) return
        refs.trigger?.focus()
      })
  }
  const toggle = () => {
    if (open()) {
      close()
      return
    }
    props.onOpen?.()
    setOpen(true)
    queueMicrotask(() => focusItem(items()[0]))
  }
  const pick = (source: PaneSource) => {
    close(true)
    props.onPick(source)
  }
  const revoke = (source: PaneSource) => {
    close(true)
    props.onRevoke?.(source)
  }

  return (
    <div class="files-source">
      <button
        ref={(element) => {
          refs.trigger = element
        }}
        type="button"
        class="files-source__button"
        data-source-button
        data-source-kind={props.active.kind}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={
          props.triggerLabel
            ? `${props.triggerLabel} file locations; current: ${props.active.name}`
            : `File source: ${props.active.name}`
        }
        title={
          props.triggerLabel
            ? "Connected folders, remote storage, and Trash"
            : (props.active.detail ?? props.active.sub)
        }
        onClick={toggle}
      >
        <span class="files-source__glyph" aria-hidden="true">
          {props.triggerLabel ? (
            <IconMoreH size={15} strokeWidth={1.5} />
          ) : (
            glyph(props.active.kind)({ size: 15, strokeWidth: 1.5 })
          )}
        </span>
        <span class="files-source__name">{props.triggerLabel ?? props.active.name}</span>
        <span class="files-source__caret" aria-hidden="true">
          <IconChevronDown size={12} strokeWidth={1.5} />
        </span>
      </button>

      <Show when={open()}>
        <div class="files-menu-wrap">
          <button type="button" class="files-menu__scrim" tabindex="-1" aria-hidden="true" onClick={() => close()} />
          <div
            ref={(element) => {
              refs.menu = element
            }}
            class="files-menu"
            data-source-menu
            role="menu"
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault()
                event.stopPropagation()
                close(true)
                return
              }
              const options = items()
              const current = options.indexOf(document.activeElement as HTMLElement)
              const target =
                event.key === "Home"
                  ? options[0]
                  : event.key === "End"
                    ? options.at(-1)
                    : event.key === "ArrowDown"
                      ? options[(current + 1 + options.length) % options.length]
                      : event.key === "ArrowUp"
                        ? options[(current - 1 + options.length) % options.length]
                        : undefined
              if (!target) return
              event.preventDefault()
              focusItem(target)
            }}
            onFocusOut={(event) => {
              const next = event.relatedTarget
              if (next instanceof Node && (refs.menu?.contains(next) || refs.trigger?.contains(next))) return
              // Refreshing the grant inventory replaces fresh PaneSource rows.
              // Browsers surface removal of the focused row with no related
              // target; closing here strands pointer and keyboard selection on
              // a menu that vanished underneath them. Keep it open and move
              // focus to the row with the same durable source id.
              if (next === null) {
                restoreRefreshFocus(event.target)
                return
              }
              close()
            }}
          >
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
                          tabindex="-1"
                          data-source-item={source.id}
                          data-source-kind={source.kind}
                          aria-checked={source === props.active}
                          onClick={() => pick(source)}
                        >
                          <span class="files-menu__glyph" aria-hidden="true">
                            {glyph(source.kind)({ size: 15, strokeWidth: 1.5 })}
                          </span>
                          <span>
                            <span class="files-menu__label">{source.name}</span>
                            <Show when={source.detail}>
                              <span class="files-menu__context">{source.detail}</span>
                            </Show>
                            <Show when={source.sub}>
                              <span class="files-menu__sub">{source.sub}</span>
                            </Show>
                          </span>
                          <span class="files-menu__tail">
                            <Show when={source.readonly}>
                              <span class="files-menu__badge">Read only</span>
                            </Show>
                            <Show when={source.kind === "connected" && !source.readonly}>
                              <span
                                class="files-menu__badge"
                                title="Approved tools and sandboxed runtimes may read and write here."
                              >
                                Read & write
                              </span>
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
                            tabindex="-1"
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
                role="menuitem"
                tabindex="-1"
                onClick={() => {
                  close(true)
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
