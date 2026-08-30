import { For, Match, Show, Switch, type JSX } from "solid-js"
import { Markdown } from "@synsci/ui/markdown"
import { DataTableView } from "@/data/DataTableView"
import type { ViewerResolution } from "./viewer-registry"
import "../FilePreview.css"

type NotebookCell = {
  type: "markdown" | "code"
  source: string
  outputs: string[]
}

function notebook(text: string): NotebookCell[] | undefined {
  const parsed = (() => {
    try {
      return JSON.parse(text) as { cells?: unknown[] }
    } catch {
      return undefined
    }
  })()
  if (!Array.isArray(parsed?.cells)) return
  return parsed.cells.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const cell = value as { cell_type?: unknown; source?: unknown; outputs?: unknown }
    if (cell.cell_type !== "markdown" && cell.cell_type !== "code") return []
    const source = Array.isArray(cell.source)
      ? cell.source.join("")
      : typeof cell.source === "string"
        ? cell.source
        : ""
    const outputs = !Array.isArray(cell.outputs)
      ? []
      : cell.outputs.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return []
          const output = entry as { text?: unknown; data?: unknown }
          if (Array.isArray(output.text)) return [output.text.join("")]
          if (typeof output.text === "string") return [output.text]
          if (!output.data || typeof output.data !== "object") return []
          const plain = (output.data as Record<string, unknown>)["text/plain"]
          if (Array.isArray(plain)) return [plain.join("")]
          return typeof plain === "string" ? [plain] : []
        })
    return [{ type: cell.cell_type, source, outputs }]
  })
}

export function TextContentView(props: { name: string; text: string; viewer: ViewerResolution }): JSX.Element {
  const cells = () => (props.viewer.kind === "notebook" ? notebook(props.text) : undefined)
  return (
    <Switch fallback={<pre class="remote-view__text">{props.text}</pre>}>
      <Match when={props.viewer.kind === "markdown"}>
        <article class="atlas-file-document">
          <Markdown class="atlas-md" text={props.text} />
        </article>
      </Match>
      <Match when={props.viewer.kind === "table" && props.viewer.table}>
        <DataTableView text={props.text} format={props.viewer.table!} name={props.name} />
      </Match>
      <Match when={props.viewer.kind === "notebook" && cells()}>
        <article aria-label={`${props.name} notebook`} class="atlas-file-document atlas-file-notebook">
          <For each={cells()}>
            {(cell, index) => (
              <section class="atlas-file-notebook-cell" data-cell-type={cell.type}>
                <Show when={cell.type === "code"}>
                  <header class="atlas-file-notebook-label">In [{index() + 1}]</header>
                </Show>
                <Show
                  when={cell.type === "markdown"}
                  fallback={<pre class="atlas-file-notebook-code">{cell.source}</pre>}
                >
                  <Markdown class="atlas-md" text={cell.source} />
                </Show>
                <For each={cell.outputs}>
                  {(output) => <pre class="atlas-file-notebook-code atlas-file-notebook-output">{output}</pre>}
                </For>
              </section>
            )}
          </For>
        </article>
      </Match>
    </Switch>
  )
}
