import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { ArtifactThumb, type ThumbProps } from "./ArtifactThumb"
import { bytes } from "./bytes"
import { ago } from "./ago"
import { IconDownload, IconEdit, IconExpand, IconMoreH, IconTrash } from "@/atlas/shared/Icon"

export interface CardProps extends ThumbProps {
  layout: "grid" | "list"
  sizes: boolean
  onOpen: (artifact: StoredArtifact) => void
  onRename: (artifact: StoredArtifact) => void
  onTrash: (artifact: StoredArtifact) => void
}

export function ArtifactCard(props: CardProps): JSX.Element {
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLButtonElement | undefined

  // The menu is wider than a grid cell, so anchoring it inside the card puts it
  // off one edge or the other -- measured at -16px, and .files-pane clips with
  // overflow: hidden, so the first column's menu was cut off rather than merely
  // misplaced. Fixed placement, clamped to the viewport, is independent of both
  // the column and the pane's own scroll.
  const place = (menu: HTMLDivElement) => {
    const anchor = trigger?.getBoundingClientRect()
    if (!anchor) return
    const box = menu.getBoundingClientRect()
    const gap = 6
    const left = Math.max(gap, Math.min(anchor.right - box.width, window.innerWidth - box.width - gap))
    const below = anchor.bottom + gap
    const top = below + box.height > window.innerHeight ? Math.max(gap, anchor.top - box.height - gap) : below
    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`
    menu.style.visibility = "visible"
  }

  // Fixed coordinates do not follow a scrolling ancestor, and .artifact-surface
  // scrolls, so a menu placed once was stranded away from its own card the
  // moment the grid moved under it. Capture phase, because the scroll happens on
  // that container rather than on the window.
  const follow = (menu: HTMLDivElement) => {
    onMount(() => {
      place(menu)
      const again = () => place(menu)
      window.addEventListener("scroll", again, true)
      window.addEventListener("resize", again)
      onCleanup(() => {
        window.removeEventListener("scroll", again, true)
        window.removeEventListener("resize", again)
      })
    })
  }

  const version = () =>
    props.artifact.versionCount > 1
      ? `Version ${props.artifact.current.version} of ${props.artifact.versionCount}`
      : `Version ${props.artifact.current.version}`

  const act = (run: (artifact: StoredArtifact) => void) => {
    setOpen(false)
    run(props.artifact)
  }

  return (
    <div class="artifact-card" data-layout={props.layout} data-capture-quality={props.artifact.current.captureQuality}>
      {/* The actions trigger is a sibling of the open control, never nested
          inside it: a control within a control is invalid, and its label folds
          into the outer control's accessible name. 53331773 and f25d7f10 each
          fixed that same defect elsewhere in this pane. */}
      <button
        type="button"
        class="artifact-card__open"
        data-card-open
        aria-label={`Open ${props.artifact.title}, ${version().toLowerCase()}`}
        onClick={() => props.onOpen(props.artifact)}
      >
        <ArtifactThumb artifact={props.artifact} url={props.url} read={props.read} highlight={props.highlight} />
        <span class="artifact-card__label">
          <span class="artifact-card__name">{props.artifact.title}</span>
          <span class="artifact-card__sub" data-card-meta>
            <span data-card-saved title={new Date(props.artifact.current.createdAt).toLocaleString()}>
              Saved {ago(props.artifact.current.createdAt)}
            </span>
            <span class="artifact-card__meta-separator" aria-hidden="true">
              ·
            </span>
            <span class="artifact-card__version" data-card-version>
              {version()}
            </span>
            <Show when={props.sizes}>
              <span class="artifact-card__meta-separator" aria-hidden="true">
                ·
              </span>
              <span data-card-size>{bytes(props.artifact.current.size)}</span>
            </Show>
          </span>
        </span>
      </button>

      <button
        type="button"
        ref={trigger}
        class="artifact-card__actions"
        data-card-menu
        aria-label={`Actions for ${props.artifact.title}`}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <IconMoreH size={15} strokeWidth={1.6} />
      </button>

      <Show when={open()}>
        <button
          type="button"
          class="artifact-menu__scrim"
          aria-label={`Dismiss actions for ${props.artifact.title}`}
          onClick={() => setOpen(false)}
        />
        <div class="artifact-menu" role="menu" ref={follow}>
          <button type="button" role="menuitem" data-action="open" onClick={() => act(props.onOpen)}>
            <IconExpand size={14} strokeWidth={1.5} />
            Open in tab
          </button>
          <a
            role="menuitem"
            data-action="download"
            href={props.url(props.artifact, true)}
            download={props.artifact.current.filename}
            onClick={() => setOpen(false)}
          >
            <IconDownload size={14} strokeWidth={1.5} />
            Download
          </a>
          <button type="button" role="menuitem" data-action="rename" onClick={() => act(props.onRename)}>
            <IconEdit size={14} strokeWidth={1.5} />
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            data-action="trash"
            class="artifact-menu__danger"
            onClick={() => act(props.onTrash)}
          >
            <IconTrash size={14} strokeWidth={1.5} />
            Move to trash
          </button>
        </div>
      </Show>
    </div>
  )
}
