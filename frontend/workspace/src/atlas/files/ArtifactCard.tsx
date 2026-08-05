import { Show, createSignal, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { ArtifactThumb, type ThumbProps } from "./ArtifactThumb"
import { bytes } from "./bytes"

export interface CardProps extends ThumbProps {
  layout: "grid" | "list"
  sizes: boolean
  onOpen: (artifact: StoredArtifact) => void
  onRename: (artifact: StoredArtifact) => void
  onTrash: (artifact: StoredArtifact) => void
}

const ago = (created: number) => {
  const minutes = Math.max(1, Math.round((Date.now() - created) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export function ArtifactCard(props: CardProps): JSX.Element {
  const [open, setOpen] = createSignal(false)

  const meta = () =>
    props.sizes
      ? `${ago(props.artifact.createdAt)} · ${bytes(props.artifact.current.size)}`
      : ago(props.artifact.createdAt)

  const act = (run: (artifact: StoredArtifact) => void) => {
    setOpen(false)
    run(props.artifact)
  }

  return (
    <div class="artifact-card" data-layout={props.layout}>
      {/* The actions trigger is a sibling of the open control, never nested
          inside it: a control within a control is invalid, and its label folds
          into the outer control's accessible name. 53331773 and f25d7f10 each
          fixed that same defect elsewhere in this pane. */}
      <button
        type="button"
        class="artifact-card__open"
        data-card-open
        aria-label={`Open ${props.artifact.title}`}
        onClick={() => props.onOpen(props.artifact)}
      >
        <ArtifactThumb artifact={props.artifact} url={props.url} read={props.read} highlight={props.highlight} />
        <span class="artifact-card__label">
          <span class="artifact-card__name">{props.artifact.title}</span>
          <span class="artifact-card__sub" data-card-meta>
            {meta()}
          </span>
        </span>
      </button>

      <button
        type="button"
        class="artifact-card__actions"
        data-card-menu
        aria-label={`Actions for ${props.artifact.title}`}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        ⋮
      </button>

      <Show when={open()}>
        <button
          type="button"
          class="artifact-menu__scrim"
          aria-label={`Dismiss actions for ${props.artifact.title}`}
          onClick={() => setOpen(false)}
        />
        <div class="artifact-menu" role="menu">
          <button type="button" role="menuitem" data-action="open" onClick={() => act(props.onOpen)}>
            Open in tab
          </button>
          <a
            role="menuitem"
            data-action="download"
            href={props.url(props.artifact, true)}
            download={props.artifact.current.filename}
            onClick={() => setOpen(false)}
          >
            Download
          </a>
          <button type="button" role="menuitem" data-action="rename" onClick={() => act(props.onRename)}>
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            data-action="trash"
            class="artifact-menu__danger"
            onClick={() => act(props.onTrash)}
          >
            Move to trash
          </button>
        </div>
      </Show>
    </div>
  )
}
