import { For, Show, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"

/**
 * The recovery half of the artifact store. StoredArtifactView promises that a
 * deleted artifact stays "recoverable from Files for 30 days" — this is the
 * surface that makes the promise true.
 */
export function TrashList(props: {
  rows: StoredArtifact[]
  busy?: boolean
  onRestore: (artifact: StoredArtifact) => void
}): JSX.Element {
  return (
    <div class="files-table" data-trash-list>
      <p class="files-trash__note">Deleted artifacts keep every version and stay recoverable for 30 days.</p>

      <Show when={props.rows.length} fallback={<div class="files-empty">Trash is empty.</div>}>
        <For each={props.rows}>
          {(artifact) => (
            <div
              class="files-row files-row--trash"
              data-trash-row={artifact.id}
              title={`${artifact.kind} · ${artifact.versionCount} version${artifact.versionCount === 1 ? "" : "s"}`}
            >
              <span class="files-row__glyph" aria-hidden="true">
                ◌
              </span>
              <span class="files-row__name" data-trash-name>
                {artifact.title}
              </span>
              <button
                type="button"
                class="files-restore"
                data-trash-restore={artifact.id}
                aria-label={`Restore ${artifact.title}`}
                disabled={props.busy}
                onClick={() => props.onRestore(artifact)}
              >
                Restore
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
