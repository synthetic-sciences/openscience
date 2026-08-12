import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { Markdown } from "@synsci/ui/markdown"
import { Diff } from "@synsci/ui/diff"
import { useSDK } from "@/context/sdk"
import { FONT_CODE, FONT_MONO, FONT_SANS } from "@/styles/tokens"
import {
  clearOutputs,
  createCell,
  exportHtml,
  exportMarkdown,
  exportScript,
  insertCell,
  moveCell,
  parseNotebook,
  removeCell,
  serializeNotebook,
  sourceText,
  updateSource,
  type NotebookCell,
  type NotebookDocument,
  type NotebookOutput,
} from "./model"
import {
  kernelCanInterrupt,
  kernelStateLabel,
  kernelStatusText,
  kernelTone,
  resolveNotebookSession,
  type KernelState,
  type KernelStatus,
} from "./runtime"

type Language = "python" | "r"

type Execution = {
  ok: boolean
  provenance_id: string
  execution_count: number | null
  outputs: NotebookOutput[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const valueText = (value: unknown) => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((part) => String(part)).join("")
  if (value === undefined || value === null) return ""
  return JSON.stringify(value, null, 2)
}

const languageOf = (notebook: NotebookDocument): Language => {
  const spec = record(notebook.metadata.kernelspec) ? notebook.metadata.kernelspec : {}
  const info = record(notebook.metadata.language_info) ? notebook.metadata.language_info : {}
  const name = String(spec.language ?? spec.name ?? info.name ?? "python").toLowerCase()
  return name === "r" || name.startsWith("ir") ? "r" : "python"
}

export function NotebookView(props: {
  path: string
  directory: string
  text: string
  savedText: string
  dirty: boolean
  saving: boolean
  onChange: (text: string) => void
  onSave: () => void
  onRaw: () => void
}): JSX.Element {
  const sdk = useSDK()
  const params = useParams()
  const [running, setRunning] = createSignal<string[]>([])
  const [owner, setOwner] = createSignal<string>()
  const [editing, setEditing] = createSignal<string>()
  const [error, setError] = createSignal("")
  const [diff, setDiff] = createSignal(false)
  const [exports, setExports] = createSignal(false)

  const parsed = createMemo(() => {
    try {
      return { notebook: parseNotebook(props.text), error: "" }
    } catch (cause) {
      return {
        notebook: undefined,
        error: cause instanceof Error ? cause.message : "Invalid notebook JSON",
      }
    }
  })
  const notebook = () => parsed().notebook
  const language = () => (notebook() ? languageOf(notebook()!) : "python")
  const session = () => (params.id && params.id !== "new" ? params.id : owner())
  const busy = () => running().length > 0
  const source = () => {
    const sessionID = session()
    if (!sessionID || !notebook()) return
    return { sessionID, id: props.path, language: language() }
  }
  const [runtime, api] = createResource(source, async (input) => {
    const response = await sdk.request("/notebook/status", undefined, input)
    if (!response.ok) throw new Error(`status failed (${response.status})`)
    return response.json() as Promise<KernelStatus>
  })
  const status = (): KernelState => runtime()?.state ?? "stopped"
  const tone = () => kernelTone(status())
  const timer = setInterval(() => {
    if (source()) void api.refetch()
  }, 1_000)
  onCleanup(() => clearInterval(timer))

  const apply = (next: NotebookDocument) => props.onChange(serializeNotebook(next))
  const replace = (index: number, next: NotebookCell) => {
    const current = notebook()
    if (!current) return
    apply({
      ...current,
      cells: current.cells.map((cell, position) => (position === index ? next : cell)),
    })
  }

  const ensureSession = async () => {
    const current = session()
    const id = await resolveNotebookSession(current, () => sdk.client.session.create())
    if (!current) setOwner(id)
    return id
  }

  const call = async (path: "restart" | "interrupt") => {
    setError("")
    if (!session()) throw new Error("Open a session before starting a kernel.")
    const response = await sdk.request(`/notebook/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: session(), id: props.path, language: language() }),
    })
    if (!response.ok) throw new Error(`${path} failed (${response.status})`)
    api.mutate((await response.json()) as KernelStatus)
  }

  const runCell = async (index: number) => {
    const current = notebook()
    const cell = current?.cells[index]
    if (!current || !cell || cell.cell_type !== "code" || busy()) return

    setRunning([cell.id])
    setError("")
    try {
      const sessionID = await ensureSession()
      const response = await sdk.request("/notebook/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionID,
          id: props.path,
          language: language(),
          code: sourceText(cell),
        }),
      })
      const result = (await response.json()) as Execution | { error?: string; message?: string }
      if (!response.ok || !("outputs" in result)) {
        throw new Error(
          ("message" in result && result.message) || ("error" in result && result.error) || "execution failed",
        )
      }
      replace(index, {
        ...cell,
        metadata: {
          ...cell.metadata,
          openscience: {
            ...(record(cell.metadata.openscience) ? cell.metadata.openscience : {}),
            provenance_id: result.provenance_id,
            language: language(),
            executed_at: new Date().toISOString(),
          },
        },
        execution_count: result.execution_count,
        outputs: result.outputs,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      replace(index, {
        ...cell,
        execution_count: null,
        outputs: [{ output_type: "error", ename: "ExecutionError", evalue: message, traceback: [] }],
      })
      setError(message)
    } finally {
      setRunning([])
      void api.refetch()
    }
  }

  const runAll = async () => {
    const cells = notebook()?.cells ?? []
    for (const cell of cells) {
      if (cell.cell_type !== "code") continue
      const index = notebook()?.cells.findIndex((value) => value.id === cell.id) ?? -1
      await runCell(index)
    }
  }

  const setLanguage = (next: Language) => {
    const current = notebook()
    if (!current || next === language()) return
    apply({
      ...current,
      metadata: {
        ...current.metadata,
        kernelspec:
          next === "r"
            ? { display_name: "R", language: "R", name: "ir" }
            : { display_name: "Python 3", language: "python", name: "python3" },
        language_info: { name: next },
      },
    })
    void call("restart").catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const snapshot = (text: string) => {
    try {
      return exportScript(parseNotebook(text), language())
    } catch {
      return text
    }
  }

  const download = (format: "script" | "markdown" | "html") => {
    const current = notebook()
    if (!current) return
    const base =
      props.path
        .split("/")
        .pop()
        ?.replace(/\.ipynb$/i, "") || "notebook"
    const output =
      format === "script"
        ? exportScript(current, language())
        : format === "markdown"
          ? exportMarkdown(current, language())
          : exportHtml(current, base)
    const extension = format === "script" ? (language() === "r" ? "r" : "py") : format === "markdown" ? "md" : "html"
    const url = URL.createObjectURL(new Blob([output], { type: "text/plain;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${base}.${extension}`
    anchor.click()
    URL.revokeObjectURL(url)
    setExports(false)
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === "s") {
        event.preventDefault()
        props.onSave()
        return
      }
      if (event.shiftKey && event.key === "Enter") {
        event.preventDefault()
        void runAll()
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <div
      data-component="notebook"
      style={{
        height: "100%",
        "min-height": "100%",
        position: "relative",
        display: "flex",
        "flex-direction": "column",
        background:
          "radial-gradient(circle at 50% -20%, color-mix(in srgb, var(--color-accent) 8%, transparent), transparent 38%), var(--color-bg-subtle)",
      }}
    >
      <Show
        when={notebook()}
        fallback={
          <div style={empty()}>
            <div
              style={{ "font-family": FONT_SANS, "font-size": "15px", "font-weight": "var(--font-weight-emphasis)" }}
            >
              This notebook needs repair
            </div>
            <div style={{ "font-family": FONT_MONO, "font-size": "11px", color: "var(--color-text-faint)" }}>
              {parsed().error}
            </div>
            <button type="button" style={button(true)} onClick={props.onRaw}>
              open raw JSON
            </button>
          </div>
        }
      >
        {(document) => (
          <>
            <div
              style={{
                position: "sticky",
                top: 0,
                "z-index": 4,
                display: "flex",
                "align-items": "center",
                gap: "8px",
                padding: "9px max(16px, calc((100% - 920px) / 2))",
                border: "0",
                "border-bottom": "1px solid var(--color-border)",
                background: "color-mix(in srgb, var(--color-bg) 94%, transparent)",
                "backdrop-filter": "blur(14px)",
                overflow: "visible",
              }}
            >
              <select
                aria-label="Notebook kernel"
                value={language()}
                disabled={busy()}
                onChange={(event) => setLanguage(event.currentTarget.value as Language)}
                style={select()}
              >
                <option value="python">Python 3</option>
                <option value="r">R</option>
              </select>
              <span
                aria-label={`Kernel ${kernelStateLabel(status())}`}
                style={{
                  width: "6px",
                  height: "6px",
                  "border-radius": "50%",
                  background:
                    tone() === "active"
                      ? "var(--color-warning, #d99b35)"
                      : tone() === "danger"
                        ? "var(--color-danger, #d85b5b)"
                        : tone() === "ready"
                          ? "var(--color-success, #4a9b71)"
                          : "var(--color-text-faint)",
                  "box-shadow":
                    status() === "running" ? "0 0 0 4px color-mix(in srgb, #d99b35 18%, transparent)" : "none",
                }}
              />
              <span style={{ "font-family": FONT_MONO, "font-size": "10px", color: "var(--color-text-faint)" }}>
                {kernelStatusText(runtime())}
              </span>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                data-action="notebook-diff"
                disabled={!props.dirty}
                style={button()}
                onClick={() => setDiff(true)}
              >
                diff
              </button>
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  data-action="notebook-export"
                  style={button()}
                  onClick={() => setExports((value) => !value)}
                >
                  export
                </button>
                <Show when={exports()}>
                  <div
                    role="menu"
                    aria-label="Export notebook"
                    style={{
                      position: "absolute",
                      top: "32px",
                      right: 0,
                      width: "160px",
                      padding: "5px",
                      display: "flex",
                      "flex-direction": "column",
                      gap: "2px",
                      border: "1px solid var(--color-border-strong)",
                      "border-radius": "7px",
                      background: "var(--color-bg)",
                      "box-shadow": "0 12px 32px rgba(0,0,0,0.18)",
                      "z-index": 8,
                    }}
                  >
                    <button type="button" role="menuitem" style={menu()} onClick={() => download("script")}>
                      {language() === "r" ? "R script (.r)" : "Python script (.py)"}
                    </button>
                    <button type="button" role="menuitem" style={menu()} onClick={() => download("markdown")}>
                      Markdown report
                    </button>
                    <button type="button" role="menuitem" style={menu()} onClick={() => download("html")}>
                      Standalone HTML
                    </button>
                  </div>
                </Show>
              </div>
              <button
                type="button"
                data-action="run-all"
                disabled={busy()}
                style={button(true)}
                onClick={() => void runAll()}
              >
                {busy() ? "running…" : "run all"}
              </button>
              <button
                type="button"
                data-action="interrupt-kernel"
                disabled={!kernelCanInterrupt(runtime())}
                style={button()}
                onClick={() => void call("interrupt").catch((cause) => setError(String(cause)))}
              >
                interrupt
              </button>
              <button
                type="button"
                data-action="restart-kernel"
                aria-label="Restart kernel and clear in-memory state"
                title="Restart in a fresh runtime. All in-memory variables and queued cells will be lost."
                style={button()}
                onClick={() => void call("restart").catch((cause) => setError(String(cause)))}
              >
                restart
              </button>
              <button type="button" style={button()} onClick={() => apply(clearOutputs(document()))}>
                clear outputs
              </button>
              <Show when={props.dirty}>
                <button type="button" disabled={props.saving} style={button(true)} onClick={props.onSave}>
                  {props.saving ? "saving…" : "save"}
                </button>
              </Show>
            </div>

            <Show when={error()}>
              <div
                role="alert"
                style={{
                  margin: "12px auto 0",
                  width: "min(calc(100% - 32px), 920px)",
                  padding: "9px 12px",
                  "box-sizing": "border-box",
                  border: "1px solid color-mix(in srgb, var(--color-danger, #d85b5b) 40%, var(--color-border))",
                  "border-radius": "6px",
                  background: "color-mix(in srgb, var(--color-danger, #d85b5b) 8%, var(--color-bg))",
                  "font-family": FONT_MONO,
                  "font-size": "11px",
                  color: "var(--color-text-muted)",
                }}
              >
                {error()}
              </div>
            </Show>

            <div
              style={{
                width: "min(calc(100% - 32px), 920px)",
                margin: "0 auto",
                padding: "22px 0 80px",
                display: "flex",
                "flex-direction": "column",
                gap: "12px",
              }}
            >
              <For each={document().cells}>
                {(cell, index) => (
                  <NotebookCellView
                    cell={cell}
                    index={index()}
                    running={running().includes(cell.id)}
                    editing={editing() === cell.id}
                    onEdit={() => setEditing(cell.id)}
                    onDone={() => setEditing(undefined)}
                    onSource={(text) => replace(index(), updateSource(cell, text))}
                    onRun={() => void runCell(index())}
                    onDelete={() => apply(removeCell(document(), index()))}
                    onUp={() => apply(moveCell(document(), index(), index() - 1))}
                    onDown={() => apply(moveCell(document(), index(), index() + 1))}
                  />
                )}
              </For>

              <div style={{ display: "flex", "justify-content": "center", gap: "8px", padding: "10px 0" }}>
                <button
                  type="button"
                  style={button()}
                  onClick={() => apply(insertCell(document(), document().cells.length, createCell("code")))}
                >
                  + code
                </button>
                <button
                  type="button"
                  style={button()}
                  onClick={() => apply(insertCell(document(), document().cells.length, createCell("markdown")))}
                >
                  + text
                </button>
              </div>
            </div>

            <Show when={diff()}>
              <div
                role="dialog"
                aria-label="Notebook changes"
                style={{
                  position: "absolute",
                  inset: 0,
                  "z-index": 12,
                  display: "flex",
                  "flex-direction": "column",
                  background: "var(--color-bg)",
                }}
              >
                <div
                  style={{
                    height: "46px",
                    display: "flex",
                    "align-items": "center",
                    gap: "10px",
                    padding: "0 14px",
                    "border-bottom": "1px solid var(--color-border)",
                  }}
                >
                  <strong style={{ "font-family": FONT_SANS, "font-size": "13px" }}>Notebook changes</strong>
                  <span style={{ "font-family": FONT_MONO, "font-size": "10px", color: "var(--color-text-faint)" }}>
                    saved checkpoint → working copy
                  </span>
                  <div style={{ flex: 1 }} />
                  <button type="button" style={button()} onClick={() => setDiff(false)}>
                    close
                  </button>
                </div>
                <div class="atlas-scroll" style={{ flex: 1, "min-height": 0, overflow: "auto" }}>
                  <Diff
                    before={{ name: props.path, contents: snapshot(props.savedText) }}
                    after={{ name: props.path, contents: snapshot(props.text) }}
                    diffStyle="split"
                  />
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

function NotebookCellView(props: {
  cell: NotebookCell
  index: number
  running: boolean
  editing: boolean
  onEdit: () => void
  onDone: () => void
  onSource: (text: string) => void
  onRun: () => void
  onDelete: () => void
  onUp: () => void
  onDown: () => void
}): JSX.Element {
  const code = () => props.cell.cell_type === "code"
  const outputs = () => (Array.isArray(props.cell.outputs) ? props.cell.outputs : [])
  const keydown = (event: KeyboardEvent) => {
    if (!code() || !event.shiftKey || event.key !== "Enter") return
    event.preventDefault()
    props.onRun()
  }

  return (
    <section
      data-cell-id={props.cell.id}
      data-cell-type={props.cell.cell_type}
      style={{
        display: "grid",
        "grid-template-columns": "52px minmax(0, 1fr)",
        border: "1px solid var(--color-border)",
        "border-radius": "8px",
        background: "var(--color-bg)",
        "box-shadow": "0 1px 0 color-mix(in srgb, var(--color-text) 3%, transparent)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          gap: "8px",
          padding: "12px 6px",
          "border-right": "1px solid var(--color-border)",
          background: "color-mix(in srgb, var(--color-bg-subtle) 72%, var(--color-bg))",
        }}
      >
        <Show
          when={code()}
          fallback={
            <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>TXT</span>
          }
        >
          <button
            type="button"
            data-action="run-cell"
            title="Run cell (Shift+Enter)"
            disabled={props.running}
            onClick={props.onRun}
            style={runButton(props.running)}
          >
            {props.running ? "■" : "▶"}
          </button>
          <span style={{ "font-family": FONT_MONO, "font-size": "9px", color: "var(--color-text-faint)" }}>
            [{props.cell.execution_count ?? " "}]
          </span>
        </Show>
      </div>

      <div style={{ "min-width": 0 }}>
        <div
          style={{
            height: "28px",
            display: "flex",
            "align-items": "center",
            "justify-content": "flex-end",
            gap: "2px",
            padding: "0 6px",
            "border-bottom": code() ? "1px solid var(--color-border)" : "none",
          }}
        >
          <Show when={!code()}>
            <button type="button" style={mini()} onClick={props.onEdit}>
              {props.editing ? "editing" : "edit"}
            </button>
          </Show>
          <button type="button" title="Move up" style={mini()} onClick={props.onUp}>
            ↑
          </button>
          <button type="button" title="Move down" style={mini()} onClick={props.onDown}>
            ↓
          </button>
          <button type="button" title="Delete cell" style={mini()} onClick={props.onDelete}>
            ×
          </button>
        </div>

        <Show
          when={code() || props.editing}
          fallback={
            <button
              type="button"
              onDblClick={props.onEdit}
              style={{
                all: "unset",
                display: "block",
                width: "100%",
                "box-sizing": "border-box",
                padding: "4px 18px 18px",
                cursor: "text",
              }}
            >
              <Show
                when={sourceText(props.cell).trim()}
                fallback={
                  <span style={{ "font-family": FONT_SANS, "font-size": "13px", color: "var(--color-text-faint)" }}>
                    Empty text cell — double-click to edit
                  </span>
                }
              >
                <Markdown class="atlas-md" text={sourceText(props.cell)} />
              </Show>
            </button>
          }
        >
          <textarea
            aria-label={`${props.cell.cell_type} cell ${props.index + 1}`}
            value={sourceText(props.cell)}
            autofocus={props.editing}
            spellcheck={!code()}
            onInput={(event) => props.onSource(event.currentTarget.value)}
            onBlur={() => !code() && props.onDone()}
            onKeyDown={keydown}
            style={{
              all: "unset",
              display: "block",
              width: "100%",
              "min-height": code() ? "84px" : "110px",
              "box-sizing": "border-box",
              padding: code() ? "14px 16px 16px" : "12px 18px 18px",
              "font-family": code() ? FONT_CODE : FONT_SANS,
              "font-size": code() ? "12px" : "13px",
              "line-height": code() ? 1.65 : 1.6,
              color: "var(--color-text)",
              resize: "vertical",
              "tab-size": 2,
            }}
          />
        </Show>

        <Show when={code() && outputs().length}>
          <div
            data-slot="notebook-output"
            style={{
              border: "0",
              "border-top": "1px solid var(--color-border)",
              background: "color-mix(in srgb, var(--color-bg-subtle) 50%, var(--color-bg))",
            }}
          >
            <For each={outputs()}>{(output) => <NotebookOutputView output={output} />}</For>
            <Show when={record(props.cell.metadata.openscience) && props.cell.metadata.openscience.provenance_id}>
              <div
                title="Local reproducibility record"
                style={{
                  padding: "6px 16px",
                  "font-family": FONT_MONO,
                  "font-size": "9px",
                  color: "var(--color-text-faint)",
                }}
              >
                provenance · {String((props.cell.metadata.openscience as Record<string, unknown>).provenance_id)}
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </section>
  )
}

function NotebookOutputView(props: { output: NotebookOutput }): JSX.Element {
  const data = () => (record(props.output.data) ? props.output.data : {})
  const png = () => valueText(data()["image/png"])
  const svg = () => valueText(data()["image/svg+xml"])
  const html = () => valueText(data()["text/html"])
  const json = () => data()["application/json"]
  const plain = () =>
    props.output.output_type === "stream" ? valueText(props.output.text) : valueText(data()["text/plain"])
  const traceback = () =>
    Array.isArray(props.output.traceback)
      ? props.output.traceback.map((line) => String(line)).join("\n")
      : `${valueText(props.output.ename)}: ${valueText(props.output.evalue)}`

  return (
    <div style={{ padding: "12px 16px", "border-bottom": "1px solid var(--color-border)" }}>
      <Show when={props.output.output_type === "error"}>
        <pre style={pre("var(--color-danger, #bd4d4d)")}>{traceback()}</pre>
      </Show>
      <Show when={props.output.output_type !== "error"}>
        <Show when={png()}>
          <img
            alt="Notebook output"
            src={`data:image/png;base64,${png()}`}
            style={{ display: "block", "max-width": "100%", height: "auto", "border-radius": "4px" }}
          />
        </Show>
        <Show when={!png() && svg()}>
          <img
            alt="Notebook output"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg())}`}
            style={{ display: "block", "max-width": "100%", height: "auto" }}
          />
        </Show>
        <Show when={!png() && !svg() && html()}>
          <iframe
            title="Notebook HTML output"
            sandbox=""
            srcdoc={`<!doctype html><meta charset="utf-8"><style>body{font:13px system-ui;margin:8px;color:#202124}table{border-collapse:collapse}td,th{padding:5px 8px;border:1px solid #ddd}</style>${html()}`}
            style={{ width: "100%", height: "220px", border: "0", background: "white", "border-radius": "4px" }}
          />
        </Show>
        <Show when={!png() && !svg() && !html() && json() !== undefined}>
          <pre style={pre()}>{valueText(json())}</pre>
        </Show>
        <Show when={!png() && !svg() && !html() && json() === undefined && plain()}>
          <pre style={pre(props.output.name === "stderr" ? "var(--color-danger, #bd4d4d)" : undefined)}>{plain()}</pre>
        </Show>
      </Show>
    </div>
  )
}

function button(primary = false): JSX.CSSProperties {
  return {
    cursor: "pointer",
    padding: "5px 10px",
    border: primary ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
    "border-radius": "5px",
    background: primary ? "var(--color-text)" : "var(--color-bg)",
    color: primary ? "var(--color-bg)" : "var(--color-text-muted)",
    "font-family": FONT_MONO,
    "font-size": "10px",
    "font-weight": "var(--font-weight-emphasis)",
  }
}

function mini(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "3px 5px",
    "border-radius": "3px",
    "font-family": FONT_MONO,
    "font-size": "9px",
    color: "var(--color-text-faint)",
  }
}

function menu(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "8px 9px",
    "border-radius": "4px",
    "font-family": FONT_SANS,
    "font-size": "11px",
    color: "var(--color-text-muted)",
  }
}

function runButton(active: boolean): JSX.CSSProperties {
  return {
    cursor: active ? "wait" : "pointer",
    width: "26px",
    height: "26px",
    display: "grid",
    "place-items": "center",
    padding: 0,
    border: "1px solid var(--color-border)",
    "border-radius": "5px",
    background: active ? "var(--color-text)" : "var(--color-bg)",
    color: active ? "var(--color-bg)" : "var(--color-text-muted)",
    "font-size": "9px",
  }
}

function select(): JSX.CSSProperties {
  return {
    height: "27px",
    padding: "0 26px 0 9px",
    border: "1px solid var(--color-border)",
    "border-radius": "5px",
    background: "var(--color-bg)",
    color: "var(--color-text)",
    "font-family": FONT_MONO,
    "font-size": "10px",
  }
}

function pre(color = "var(--color-text-muted)"): JSX.CSSProperties {
  return {
    margin: 0,
    "white-space": "pre-wrap",
    "overflow-wrap": "anywhere",
    "font-family": FONT_CODE,
    "font-size": "11px",
    "line-height": 1.55,
    color,
  }
}

function empty(): JSX.CSSProperties {
  return {
    flex: 1,
    display: "flex",
    "flex-direction": "column",
    "align-items": "center",
    "justify-content": "center",
    gap: "12px",
    padding: "32px",
    "text-align": "center",
    color: "var(--color-text)",
  }
}

export default NotebookView
