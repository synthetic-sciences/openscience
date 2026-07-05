import { createSignal, For, Show, type JSX } from "solid-js"
import DOMPurify from "dompurify"
import { Icon } from "./icon"

// Notebook `text/html` outputs are untrusted (a malicious .ipynb or a
// prompt-injected cell can emit arbitrary markup). Sanitize before injecting so
// tables/plots still render but <script>, event handlers, and javascript: URLs
// are stripped. Default profile keeps html+svg+mathml.
const sanitizeHtml = (html: string) => (DOMPurify.isSupported ? DOMPurify.sanitize(html) : "")

export interface NotebookCellProps {
  cellType: "code" | "markdown"
  source: string
  outputs?: NotebookOutput[]
  executionCount?: number | null
  collapsed?: boolean
}

interface NotebookOutput {
  type: "stream" | "execute_result" | "display_data" | "error"
  text?: string
  name?: string
  data?: Record<string, string>
  ename?: string
  evalue?: string
  traceback?: string[]
  executionCount?: number
}

export function NotebookCell(props: NotebookCellProps): JSX.Element {
  const [expanded, setExpanded] = createSignal(!props.collapsed)

  const prompt = () => {
    if (props.cellType === "markdown") return ""
    const num = props.executionCount
    return num != null ? `[${num}]` : "[ ]"
  }

  return (
    <div data-component="notebook-cell" data-cell-type={props.cellType}>
      <div data-slot="notebook-cell-header" onClick={() => setExpanded((v) => !v)}>
        <Show when={props.cellType === "code"}>
          <span data-slot="notebook-cell-prompt">{prompt()}</span>
        </Show>
        <Show when={props.cellType === "markdown"}>
          <Icon name="align-right" size="small" />
        </Show>
        <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
      </div>
      <Show when={expanded()}>
        <div data-slot="notebook-cell-source">
          <pre>
            <code>{props.source}</code>
          </pre>
        </div>
        <Show when={props.outputs && props.outputs.length > 0}>
          <div data-slot="notebook-cell-outputs">
            <For each={props.outputs}>{(output) => <NotebookOutputView output={output} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function NotebookOutputView(props: { output: NotebookOutput }): JSX.Element {
  const output = () => props.output

  return (
    <div data-component="notebook-output" data-output-type={output().type}>
      <Show when={output().type === "stream"}>
        <pre data-slot="notebook-output-stream" data-stream-name={output().name}>
          {output().text}
        </pre>
      </Show>
      <Show when={output().type === "execute_result" || output().type === "display_data"}>
        <div data-slot="notebook-output-data">
          <Show when={output().data?.["image/png"]}>
            <img
              src={`data:image/png;base64,${output().data!["image/png"]}`}
              alt="Output"
              data-slot="notebook-output-image"
            />
          </Show>
          <Show when={output().data?.["text/html"]}>
            <div data-slot="notebook-output-html" innerHTML={sanitizeHtml(output().data!["text/html"])} />
          </Show>
          <Show when={output().data?.["text/plain"] && !output().data?.["image/png"] && !output().data?.["text/html"]}>
            <pre data-slot="notebook-output-text">{output().data!["text/plain"]}</pre>
          </Show>
        </div>
      </Show>
      <Show when={output().type === "error"}>
        <div data-slot="notebook-output-error">
          <div data-slot="notebook-error-name">
            {output().ename}: {output().evalue}
          </div>
          <Show when={output().traceback && output().traceback!.length > 0}>
            <pre data-slot="notebook-error-traceback">
              {output()
                .traceback!.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
                .join("\n")}
            </pre>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export function NotebookView(props: { cells: NotebookCellProps[]; title?: string }): JSX.Element {
  return (
    <div data-component="notebook-view">
      <Show when={props.title}>
        <div data-slot="notebook-title">{props.title}</div>
      </Show>
      <For each={props.cells}>
        {(cell) => (
          <NotebookCell
            cellType={cell.cellType}
            source={cell.source}
            outputs={cell.outputs}
            executionCount={cell.executionCount}
            collapsed={cell.collapsed}
          />
        )}
      </For>
    </div>
  )
}
