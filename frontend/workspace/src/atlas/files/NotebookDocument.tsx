import { createEffect, createMemo, For, Match, onCleanup, Show, Switch, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Markdown } from "@synsci/ui/markdown"
import {
  notebookHtml,
  notebookImage,
  notebookMarkdown,
  notebookOutputs,
  parseComputationalMarkdown,
  parseNotebook,
  type NotebookCell,
  type NotebookOutput,
} from "./notebook"

export type NotebookExecution = { ok: boolean; execution_count: number | null; outputs: unknown[] }

export function NotebookDocument(
  props: Pick<ComponentProps<typeof Markdown>, "resolveImage" | "resolveFile" | "onOpenFile"> & {
    name: string
    text: string
    format: string
    sessionID?: string
    run?: (cell: NotebookCell, index: number) => Promise<NotebookExecution>
  },
) {
  const document = createMemo(() => ({
    name: props.name,
    session: props.sessionID,
    ...(props.format === "ipynb" ? parseNotebook(props.text) : parseComputationalMarkdown(props.text)),
  }))
  type Execution = { outputs: NotebookOutput[]; count?: number; error?: string; ok?: boolean }
  const [state, setState] = createStore<{ running?: number; executions: Record<number, Execution> }>({ executions: {} })
  let live = true
  onCleanup(() => {
    live = false
  })
  createEffect(() => {
    document()
    setState({ running: undefined, executions: {} })
  })
  const language = (cell: NotebookCell) =>
    cell.language === "r" ? "R" : cell.language === "python" ? "Python" : cell.language
  const runnable = (cell: NotebookCell) => cell.language === "python" || cell.language === "r"
  const run = async (cell: NotebookCell, index: number) => {
    if (!props.run || state.running !== undefined || !runnable(cell) || !cell.source.trim()) return
    const current = document()
    setState("running", index)
    const result = await props.run(cell, index).then(
      (value): Execution => ({
        outputs: notebookOutputs(value.outputs),
        count: value.execution_count ?? undefined,
        ok: value.ok,
      }),
      (error): Execution => ({ outputs: [], error: error instanceof Error ? error.message : String(error) }),
    )
    if (!live || document() !== current) return
    setState("executions", index, { error: undefined, count: undefined, ok: undefined, ...result })
    setState("running", undefined)
  }
  const markdown = (text: string, cell: NotebookCell) => (
    <Markdown
      class="atlas-md"
      text={notebookMarkdown(text, cell.attachments)}
      resolveImage={(src) =>
        src.startsWith("attachment:")
          ? (notebookImage(cell.attachments?.[src.slice(11)]) ?? "")
          : (props.resolveImage?.(src) ?? src)
      }
      resolveFile={props.resolveFile}
      onOpenFile={props.onOpenFile}
    />
  )
  return (
    <article aria-label={`${props.name} notebook`} class="atlas-file-document atlas-file-notebook">
      <Show when={document().error}>
        {(error) => (
          <div class="atlas-file-notice" role="alert">
            {error()}
          </div>
        )}
      </Show>
      <Show when={!document().error && !document().cells.length}>
        <p class="atlas-notebook-hint">This document has no cells yet. Open Edit to add content.</p>
      </Show>
      <Show when={document().cells.some((cell) => cell.type === "code")}>
        <p class="atlas-notebook-hint">
          {props.run
            ? "Run cells in this session’s local kernel. New outputs stay in this preview; the file changes only when you edit and save it."
            : "Saved outputs. Open this file in a research session to run Python or R cells."}
        </p>
      </Show>
      <For each={document().cells}>
        {(cell, index) => {
          const execution = () => state.executions[index()]
          const outputs = () => execution()?.outputs ?? cell.outputs
          return (
            <section class="atlas-file-notebook-cell" data-cell-type={cell.type} aria-label={`Cell ${index() + 1}`}>
              <Switch>
                <Match when={cell.type === "markdown"}>{markdown(cell.source, cell)}</Match>
                <Match when={cell.type === "raw"}>
                  <details>
                    <summary>{cell.label ?? "Raw cell"}</summary>
                    <pre class="atlas-file-notebook-code">{cell.source}</pre>
                  </details>
                </Match>
                <Match when={cell.type === "code"}>
                  <header class="atlas-file-notebook-label">
                    <span>
                      {language(cell)}{" "}
                      <span class="atlas-notebook-count">[{execution()?.count ?? cell.count ?? " "}]</span>
                      <Show when={cell.label}> · {cell.label}</Show>
                    </span>
                    <Show when={runnable(cell)} fallback={<span>Execution unavailable</span>}>
                      <button
                        type="button"
                        class="atlas-file-button"
                        aria-label={`Run cell ${index() + 1} in ${language(cell)}`}
                        disabled={!props.run || state.running !== undefined || !cell.source.trim()}
                        title={
                          props.run
                            ? `Run in the current local ${language(cell)} kernel`
                            : "Open a research session to run this cell"
                        }
                        onClick={() => void run(cell, index())}
                      >
                        {state.running === index() ? "Running…" : "Run"}
                      </button>
                    </Show>
                  </header>
                  <pre class="atlas-file-notebook-code">
                    <code>{cell.source}</code>
                  </pre>
                  <Show when={execution() || outputs().length}>
                    <div class="atlas-file-notebook-output" aria-live="polite">
                      <div class="atlas-notebook-output-label">
                        {execution() ? "Run output · not saved" : "Saved output"}
                      </div>
                      <Show when={execution()?.error}>
                        {(error) => (
                          <pre class="atlas-file-notebook-code" role="alert">
                            {error()}
                          </pre>
                        )}
                      </Show>
                      <Show when={execution()?.ok === false && !outputs().some((output) => output.kind === "error")}>
                        <p role="alert">The kernel reported an unsuccessful execution.</p>
                      </Show>
                      <Show when={execution()?.ok === true && !outputs().length}>
                        <p class="atlas-notebook-hint">Completed without output.</p>
                      </Show>
                      <For each={outputs()}>
                        {(output) => (
                          <Switch>
                            <Match when={output.kind === "image"}>
                              {output.kind === "image" && (
                                <img class="atlas-notebook-image" src={output.src} alt={`Cell ${index() + 1} output`} />
                              )}
                            </Match>
                            <Match when={output.kind === "html"}>
                              {output.kind === "html" && (
                                <iframe
                                  class="atlas-notebook-html"
                                  sandbox=""
                                  title={`Cell ${index() + 1} HTML output`}
                                  srcdoc={notebookHtml(output.text)}
                                />
                              )}
                            </Match>
                            <Match when={output.kind === "markdown"}>
                              {output.kind === "markdown" && markdown(output.text, cell)}
                            </Match>
                            <Match when={output.kind === "text" || output.kind === "error"}>
                              {output.kind !== "image" && (
                                <pre
                                  class="atlas-file-notebook-code"
                                  role={output.kind === "error" ? "alert" : undefined}
                                >
                                  {output.text}
                                </pre>
                              )}
                            </Match>
                          </Switch>
                        )}
                      </For>
                    </div>
                  </Show>
                </Match>
              </Switch>
            </section>
          )
        }}
      </For>
    </article>
  )
}
