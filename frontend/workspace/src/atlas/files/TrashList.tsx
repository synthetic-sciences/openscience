import { For, Show, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { IconFile, IconRefresh } from "@/atlas/shared/Icon"
import { ago } from "./ago"

/**
 * The recovery half of the artifact store. StoredArtifactView promises that a
 * deleted artifact stays "recoverable from Files for 30 days" — this is the
 * surface that makes the promise true.
 */
export function TrashList(props: {
  rows: StoredArtifact[]
  busy?: boolean
  filtered?: boolean
  loading?: boolean
  unavailable?: boolean
  onRestore: (artifact: StoredArtifact) => void
}): JSX.Element {
  return (
    <div class="files-table" data-trash-list>
      <p class="files-trash__note">Deleted artifacts remain recoverable for 30 days, including saved versions.</p>

      <Show
        when={props.rows.length}
        fallback={
          <Show when={!props.loading && !props.unavailable}>
            <div class="files-empty">
              {props.filtered ? "No deleted artifacts match this search." : "Trash is empty."}
            </div>
          </Show>
        }
      >
        <For each={props.rows}>
          {(artifact) => (
            <div class="files-row files-row--trash" data-trash-row={artifact.id}>
              <span class="files-row__glyph" aria-hidden="true">
                <IconFile size={15} strokeWidth={1.45} />
              </span>
              <span class="files-row__name files-row__identity">
                <span data-trash-name>{artifact.title}</span>
                <span class="files-row__meta" data-trash-meta>
                  {artifact.versionCount} {artifact.versionCount === 1 ? "version" : "versions"}
                  <Show when={artifact.trashedAt ?? artifact.updatedAt}>
                    {(deleted) => <> · Deleted {ago(deleted())}</>}
                  </Show>
                </span>
              </span>
              <button
                type="button"
                class="files-restore"
                data-trash-restore={artifact.id}
                aria-label={`Restore ${artifact.title}`}
                disabled={props.busy}
                onClick={() => props.onRestore(artifact)}
              >
                <IconRefresh size={13} strokeWidth={1.5} />
                Restore
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
