import { For, Match, Show, Switch, type JSX } from "solid-js"
import { Markdown } from "@synsci/ui/markdown"
import { DataTableView } from "@/data/DataTableView"
import type { ViewerResolution } from "./viewer-registry"

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
        <article class="markdown-body" style={{ padding: "24px", margin: "0 auto", width: "min(100%, 760px)" }}>
          <Markdown text={props.text} />
        </article>
      </Match>
      <Match when={props.viewer.kind === "table" && props.viewer.table}>
        <DataTableView text={props.text} format={props.viewer.table!} name={props.name} />
      </Match>
      <Match when={props.viewer.kind === "notebook" && cells()}>
        <article
          aria-label={`${props.name} notebook`}
          style={{ width: "min(100%, 840px)", margin: "0 auto", padding: "20px", display: "grid", gap: "12px" }}
        >
          <For each={cells()}>
            {(cell, index) => (
              <section style={{ border: "1px solid var(--border-weak-base)", "border-radius": "var(--radius-md)" }}>
                <header style={{ padding: "7px 10px", color: "var(--text-weak)", "font-size": "11px" }}>
                  {cell.type === "markdown" ? "Markdown" : `In [${index() + 1}]`}
                </header>
                <Show
                  when={cell.type === "markdown"}
                  fallback={
                    <pre style={{ margin: 0, padding: "10px 12px", "white-space": "pre-wrap" }}>{cell.source}</pre>
                  }
                >
                  <div style={{ padding: "2px 12px 12px" }}>
                    <Markdown text={cell.source} />
                  </div>
                </Show>
                <For each={cell.outputs}>
                  {(output) => (
                    <pre
                      style={{
                        margin: 0,
                        padding: "10px 12px",
                        "border-top": "1px solid var(--border-weak-base)",
                        "white-space": "pre-wrap",
                      }}
                    >
                      {output}
                    </pre>
                  )}
                </For>
              </section>
            )}
          </For>
        </article>
      </Match>
    </Switch>
  )
}
