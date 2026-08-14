import { For, Show, createMemo, type JSX } from "solid-js"
import { IconArrowUp, IconFile, IconFolder } from "@/atlas/shared/Icon"
import { bytes } from "./bytes"

export interface FileRow {
  name: string
  type: "file" | "directory"
  size?: number
  ignored?: boolean
  /** Canonical location returned by the local file API. */
  absolute?: string
  /**
   * The server's own handle for the row (File.list, backend/cli/src/file/index.ts:522):
   * relative to the listing root when the folder sits inside it, absolute when
   * it does not. The table never shows it — opening a row does.
   */
  path?: string
}

export function FileTable(props: {
  rows: FileRow[]
  depth: number
  onOpen: (row: FileRow) => void
  onUp: () => void
  /** The visible rows are a search result, not the folder's full contents. */
  filtered?: boolean
  /** Suppresses a false empty state while the first listing is in flight. */
  loading?: boolean
  /** Suppresses a false empty state when the listing could not be read. */
  unavailable?: boolean
  /**
   * A listing is in flight. The rows on screen still describe the folder being
   * left, so they are shown but not clickable: clicking one would append its
   * name to the path the previous click already set, asking the server for a
   * folder inside a folder that was never opened.
   */
  busy?: boolean
}): JSX.Element {
  const sorted = createMemo(() =>
    [...props.rows].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
    ),
  )

  return (
    <div class="files-table" classList={{ "files-table--busy": props.busy }} aria-busy={props.busy}>
      <Show when={sorted().length > 0}>
        <div class="files-table__header" aria-hidden="true">
          <span />
          <span>Name</span>
          <span>Size</span>
        </div>
      </Show>

      <Show when={props.depth > 0}>
        <button
          type="button"
          class="files-row files-row--up"
          data-file-up
          aria-label="Go to parent folder"
          disabled={props.busy}
          onClick={() => props.onUp()}
        >
          <span class="files-row__glyph" aria-hidden="true">
            <IconArrowUp size={14} strokeWidth={1.5} />
          </span>
          <span class="files-row__name">Parent folder</span>
          <span class="files-row__size" />
        </button>
      </Show>

      <Show
        when={sorted().length > 0}
        fallback={
          <Show when={!props.loading && !props.unavailable}>
            <div class="files-empty files-empty--folder" data-folder-empty>
              <strong>{props.filtered ? "No matching files" : "This folder is empty"}</strong>
              <span>
                {props.filtered ? "Try a different name or clear the search." : "This location contains no files."}
              </span>
            </div>
          </Show>
        }
      >
        <For each={sorted()}>
          {(row) => (
            <button
              type="button"
              class="files-row"
              classList={{ "files-row--ignored": row.ignored }}
              data-file-row={row.name}
              data-file-kind={row.type}
              aria-label={`${row.type === "directory" ? "Open folder" : "Open file"} ${row.name}`}
              title={row.ignored ? `${row.name} is ignored by the project` : row.name}
              disabled={props.busy}
              onClick={() => props.onOpen(row)}
            >
              <span class="files-row__glyph" aria-hidden="true">
                {row.type === "directory" ? (
                  <IconFolder size={15} strokeWidth={1.45} />
                ) : (
                  <IconFile size={15} strokeWidth={1.45} />
                )}
              </span>
              <span class="files-row__name" data-file-name>
                {row.name}
              </span>
              <span class="files-row__size" data-file-size>
                {row.type === "directory" ? "" : bytes(row.size)}
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}
