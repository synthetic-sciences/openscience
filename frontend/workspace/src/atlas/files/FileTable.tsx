import { For, Show, createMemo, type JSX } from "solid-js"
import { bytes } from "./bytes"

export interface FileRow {
  name: string
  type: "file" | "directory"
  size?: number
  ignored?: boolean
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
}): JSX.Element {
  const sorted = createMemo(() =>
    [...props.rows].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
    ),
  )

  return (
    <div class="files-table">
      <Show when={props.depth > 0}>
        <button type="button" class="files-row files-row--up" data-file-up onClick={() => props.onUp()}>
          <span class="files-row__glyph" aria-hidden="true">
            ↑
          </span>
          <span class="files-row__name">..</span>
          <span class="files-row__size" />
        </button>
      </Show>

      <Show when={sorted().length > 0} fallback={<div class="files-empty">This folder is empty.</div>}>
        <For each={sorted()}>
          {(row) => (
            <button
              type="button"
              class="files-row"
              classList={{ "files-row--ignored": row.ignored }}
              data-file-row={row.name}
              onClick={() => props.onOpen(row)}
            >
              <span class="files-row__glyph" aria-hidden="true">
                {row.type === "directory" ? "▭" : "▫"}
              </span>
              <span class="files-row__name" data-file-name>
                {row.name}
              </span>
              <span class="files-row__size" data-file-size>
                {row.type === "directory" ? "—" : bytes(row.size)}
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}
