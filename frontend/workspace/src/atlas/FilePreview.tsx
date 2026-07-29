import {
  createSignal,
  createResource,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  type JSX,
  Show,
  Switch,
  Match,
} from "solid-js"
import { Portal } from "solid-js/web"
import { Markdown } from "@synsci/ui/markdown"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePlatform } from "@/context/platform"
import { FONT_MONO, FONT_SANS, FONT_CODE } from "@/styles/tokens"
import { PdfViewer } from "@/science/renderers/documents/PdfViewer"
import { ScienceArtifact } from "@/science/ScienceArtifact"
import { detectScientificFile } from "@/science/files"
import { ScientificDataView } from "@/science/formats/ScientificDataView"
import { detectBiologicalFormat } from "@/science/formats/biological"
import { BinaryScienceView } from "@/science/formats/BinaryScienceView"
import { detectBinaryScienceFormat } from "@/science/formats/binary"
import { NotebookView } from "@/notebook/NotebookView"
import { DataTableView } from "@/data/DataTableView"
import type { TableFormat } from "@/data/table"
import { ManuscriptWorkbench } from "@/manuscript/ManuscriptWorkbench"
import { parseManuscript } from "@/manuscript/model"
import { artifactContext, createArtifactContext } from "@/artifacts/context"
import type { ArtifactInspection } from "@/science/renderers"
import { toast } from "@/atlas/Toast"
import { IconFile, IconX, IconCopy, IconDownload, IconBookOpen, IconBraces } from "@/atlas/shared/Icon"

/**
 * Slide-in SIDE PREVIEW pane for opening a file from the Files tree.
 *
 * A file's extension picks the renderer:
 *   .md / .markdown  → formatted markdown (@synsci/ui Markdown)
 *   .pdf             → PdfViewer (pdfjs page rasterizer)
 *   molecular/FASTA  → scientific artifact renderer, with editable source
 *   .tex / .latex    → highlighted LaTeX source (a .tex is a source FILE, not a
 *                      math expression — the KaTeX LatexView is reserved for
 *                      kind:"latex" math ARTIFACTS with a single math string)
 *   images           → inline <img>
 *   everything else  → syntax-aware code/text view (with edit + save)
 *
 * It mounts as a right-anchored drawer over the session so md / pdf / latex
 * get room to breathe instead of the cramped 360px pane. Esc / backdrop
 * click / the header × all close it.
 */

const ext = (name: string): string => {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

// Extension → shiki/highlight.js language id for the code fallback.
const LANG: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rs: "rust",
  go: "go",
  swift: "swift",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cu: "cpp",
  // .tex and friends are text/source files — highlight them as LaTeX source
  // (shiki has a `latex` grammar). A full \documentclass document must never
  // be fed to KaTeX (which only typesets a single math string → blank page).
  tex: "latex",
  latex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "latex",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  r: "r",
  jl: "julia",
  lua: "lua",
  dockerfile: "docker",
  makefile: "makefile",
  csv: "csv",
  txt: "text",
  log: "text",
}

type Kind =
  | "markdown"
  | "notebook"
  | "table"
  | "scientific-data"
  | "scientific-binary"
  | "pdf"
  | "image"
  | "science"
  | "code"
  | "binary"

type FileData = { content?: string; encoding?: string; mimeType?: string; size?: number; truncated?: boolean }

/**
 * Inline file view — header (icon + name + subtitle + controls) over the
 * type-aware renderer body. This is the single source of truth for the
 * renderer dispatch; both the slide-in drawer (FilePreview, below) and the
 * center-pane document tabs mount it, so nothing about opening a file is
 * duplicated.
 */
export function FileView(props: {
  path: string
  directory?: string
  subtitle?: string
  onClose?: () => void
  active?: boolean
}): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()
  const platform = usePlatform()
  const directory = () => props.directory || sync.project?.worktree || sync.data.path.directory || sdk.directory
  const name = () => props.path.split("/").pop() || props.path
  const e = () => ext(name())

  // `showSource` flips rendered docs (md / tex) to their raw text; for code
  // files it flips the read-only highlighted view into an editable textarea.
  const [showSource, setShowSource] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [savedText, setSavedText] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [refreshKey, setRefreshKey] = createSignal(0)
  const [inspection, setInspection] = createSignal<ArtifactInspection>()

  const [file] = createResource(
    () => [directory(), props.path, refreshKey()] as const,
    async ([dir, path]) => {
      if (!dir || !path) return undefined
      // Pass the params FLAT — the generated client maps `directory`/`path`
      // into the query string; a `{ query: {...} }` wrapper is dropped and
      // sends nothing. `directory` re-roots the backend Instance so any host
      // file is readable by absolute directory + relative path (File.read).
      const res: any = await sdk.client.file.read({ directory: dir, path })
      return (res?.data ?? res) as FileData
    },
  )

  const data = () => file()
  const isBinary = () => data()?.encoding === "base64"
  const truncated = () => data()?.truncated === true
  const mime = () => data()?.mimeType ?? ""
  const b64 = () => data()?.content ?? ""
  const dataUrl = () => `data:${mime() || "application/octet-stream"};base64,${b64()}`
  const text = () => (!data() || isBinary() ? "" : (data()!.content ?? ""))
  const dirty = () => draft() !== savedText()
  const scientific = createMemo(() => (isBinary() ? undefined : detectScientificFile(e(), draft())))
  const biological = createMemo(() => (isBinary() ? undefined : detectBiologicalFormat(e())))
  const binaryScience = createMemo(() => detectBinaryScienceFormat(e()))
  const tabular = createMemo<TableFormat | undefined>(() => {
    if (isBinary()) return
    if (e() === "csv" || e() === "tsv" || e() === "jsonl") return e() as TableFormat
    if (e() === "json" && draft().trimStart().startsWith("[")) return "json"
  })

  const kind = createMemo<Kind>(() => {
    const x = e()
    if (isBinary()) {
      if (mime().startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(x)) return "image"
      if (mime() === "application/pdf" || x === "pdf") return "pdf"
      if (binaryScience()) return "scientific-binary"
      return "binary"
    }
    if (x === "md" || x === "markdown" || x === "mdx") return "markdown"
    if (x === "ipynb") return "notebook"
    if (tabular()) return "table"
    if (biological()) return "scientific-data"
    if (x === "pdf") return "pdf"
    if (scientific()) return "science"
    // .tex / .latex / .sty / .cls are source files → highlighted "code" view
    // (LANG maps them to the shiki `latex` grammar). They are NEVER routed to
    // KaTeX, which blanks on a full \documentclass document.
    return "code"
  })
  const manuscript = createMemo(() => parseManuscript(draft()).bibliographies.length > 0)

  const badge = () => {
    const k = kind()
    if (k === "code") return LANG[e()] ?? e() ?? "text"
    if (k === "science") return scientific()?.format ?? e()
    if (k === "scientific-data") return biological() ?? e()
    if (k === "scientific-binary") return binaryScience() ?? e()
    if (k === "table") return tabular() ?? e()
    return k
  }
  const context = createMemo(() =>
    createArtifactContext({
      directory: directory(),
      path: props.path,
      format: badge(),
      scienceKind: scientific()?.kind,
      inspection: inspection(),
    }),
  )

  createEffect(() => {
    const current = context()
    if (props.active === false) {
      artifactContext.clear(current.id)
      return
    }
    artifactContext.activate(current)
  })

  onCleanup(() => artifactContext.clear(context().id))

  createEffect(() => {
    if (file.loading) return
    const next = text()
    setDraft(next)
    setSavedText(next)
  })

  const save = async () => {
    if (saving() || isBinary() || truncated() || !dirty()) return
    setSaving(true)
    try {
      // The generated SDK has no file.write; hit the real PUT /file/content
      // route directly. `directory` re-roots the backend Instance, `path` is
      // relative to it (see server middleware + File.write).
      const url = `${sdk.url.replace(/\/$/, "")}/file/content?directory=${encodeURIComponent(directory())}`
      const doFetch = platform.fetch ?? fetch
      const res = await doFetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: props.path, content: draft() }),
      })
      if (!res.ok) throw new Error(`save failed (${res.status})`)
      const d: any = await res.json().catch(() => ({}))
      const next = typeof d?.content === "string" ? d.content : draft()
      setDraft(next)
      setSavedText(next)
      toast.success("saved", name())
    } catch (err: any) {
      toast.error("save failed", err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(isBinary() ? dataUrl() : draft())
      toast.success("copied", name())
    } catch {}
  }

  const download = async () => {
    try {
      const doFetch = platform.fetch ?? fetch
      const url = `${sdk.url.replace(/\/$/, "")}/file/raw?directory=${encodeURIComponent(directory())}&path=${encodeURIComponent(props.path)}`
      const response = await doFetch(url)
      if (!response.ok) throw new Error(`download failed (${response.status})`)
      const object = URL.createObjectURL(await response.blob())
      const anchor = document.createElement("a")
      anchor.href = object
      anchor.download = name()
      anchor.click()
      URL.revokeObjectURL(object)
    } catch (error) {
      toast.error("download failed", error instanceof Error ? error.message : String(error))
    }
  }

  const toggleable = () =>
    kind() === "markdown" ||
    kind() === "notebook" ||
    kind() === "table" ||
    kind() === "scientific-data" ||
    kind() === "science" ||
    kind() === "code"

  return (
    <div
      data-component="file-view"
      data-artifact-id={context().id}
      style={{
        flex: 1,
        "min-height": 0,
        "min-width": 0,
        display: "flex",
        "flex-direction": "column",
        background: "var(--color-surface-solid)",
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "10px",
          padding: "10px 12px 10px 16px",
          "border-bottom": "1px solid var(--color-border)",
          background: "var(--color-bg)",
          "flex-shrink": 0,
        }}
      >
        <IconFile size={14} strokeWidth={1.5} />
        <div style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "1px" }}>
          <span
            title={props.path}
            style={{
              "font-family": FONT_CODE,
              "font-size": "12px",
              color: "var(--color-text)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {name()}
          </span>
          <Show when={props.subtitle}>
            <span
              title={props.subtitle}
              style={{
                "font-family": FONT_MONO,
                "font-size": "10px",
                color: "var(--color-text-faint)",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {props.subtitle}
            </span>
          </Show>
        </div>
        <Show when={dirty()}>
          <button type="button" onClick={() => setDraft(savedText())} style={ctlBtn()}>
            reset
          </button>
          <button type="button" onClick={() => void save()} style={ctlBtn(true)}>
            {saving() ? "saving…" : "save"}
          </button>
        </Show>

        <Show when={toggleable() && !truncated()}>
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            title={showSource() ? "rendered view" : kind() === "code" ? "edit source" : "raw source"}
            aria-label={showSource() ? "Rendered view" : "Source"}
            style={iconBtn(showSource())}
          >
            <Show when={showSource()} fallback={<IconBraces size={13} strokeWidth={1.6} />}>
              <IconBookOpen size={13} strokeWidth={1.6} />
            </Show>
          </button>
        </Show>

        <Show when={!isBinary()}>
          <button type="button" onClick={() => void copy()} title="copy contents" aria-label="Copy" style={iconBtn()}>
            <IconCopy size={13} strokeWidth={1.6} />
          </button>
        </Show>
        <Show when={isBinary()}>
          <button
            type="button"
            onClick={() => void download()}
            title="download"
            aria-label="Download"
            style={iconBtn()}
          >
            <IconDownload size={13} strokeWidth={1.6} />
          </button>
        </Show>

        <Show when={props.onClose}>
          <button type="button" onClick={() => props.onClose!()} title="close" style={iconBtn()}>
            <IconX size={14} strokeWidth={1.7} />
          </button>
        </Show>
      </div>

      {/* body */}
      <Show
        when={!file.loading}
        fallback={
          <div
            style={{ padding: "20px", "font-family": FONT_MONO, "font-size": "12px", color: "var(--color-text-faint)" }}
          >
            loading…
          </div>
        }
      >
        <Show
          when={!file.error}
          fallback={
            <div
              style={{
                flex: 1,
                "min-height": 0,
                display: "flex",
                "flex-direction": "column",
                "align-items": "center",
                "justify-content": "center",
                gap: "10px",
                padding: "40px 24px",
                "text-align": "center",
                background: "var(--color-bg-subtle)",
              }}
            >
              <IconFile size={20} strokeWidth={1.4} />
              <div
                style={{
                  "font-family": FONT_SANS,
                  "font-size": "13px",
                  "font-weight": 500,
                  color: "var(--color-text)",
                }}
              >
                couldn't open this file
              </div>
              <div
                style={{
                  "font-family": FONT_SANS,
                  "font-size": "12px",
                  color: "var(--color-text-faint)",
                  "line-height": 1.5,
                  "max-width": "340px",
                }}
              >
                {file.error instanceof Error ? file.error.message : String(file.error)}
              </div>
              <button type="button" onClick={() => setRefreshKey((k) => k + 1)} style={retryBtn()}>
                retry
              </button>
            </div>
          }
        >
          <div
            class="atlas-scroll"
            style={{
              flex: 1,
              "min-height": 0,
              overflow: "auto",
              background: "var(--color-bg-subtle)",
            }}
          >
            <Switch>
              <Match when={truncated()}>
                <div
                  style={{
                    padding: "16px 18px 28px",
                    "font-family": FONT_CODE,
                    "font-size": "12px",
                    "line-height": 1.65,
                    color: "var(--color-text)",
                  }}
                >
                  <div
                    role="status"
                    style={{
                      padding: "10px 12px",
                      "margin-bottom": "14px",
                      border: "1px solid var(--color-border)",
                      "border-radius": "6px",
                      background: "var(--color-bg)",
                      "font-family": FONT_SANS,
                      color: "var(--color-text-muted)",
                      "white-space": "normal",
                    }}
                  >
                    Preview limited to 8 MB of {formatBytes(data()?.size ?? 0)}. Download the file or use a compute tool
                    for the complete dataset.
                  </div>
                  <pre style={{ margin: 0, "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>{draft()}</pre>
                </div>
              </Match>
              {/* citation-aware manuscripts keep the research authoring workbench */}
              <Match when={kind() === "markdown" && !showSource() && manuscript()}>
                <ManuscriptWorkbench
                  directory={directory()}
                  path={props.path}
                  text={draft()}
                  dirty={dirty()}
                  saving={saving()}
                  onChange={setDraft}
                />
              </Match>

              {/* ordinary Markdown opens as a quiet document */}
              <Match when={kind() === "markdown" && !showSource() && !manuscript()}>
                <div style={{ padding: "24px 28px 48px", width: "100%", "max-width": "920px", margin: "0 auto" }}>
                  <Markdown class="atlas-md" text={draft()} />
                </div>
              </Match>

              {/* notebook */}
              <Match when={kind() === "notebook" && !showSource()}>
                <NotebookView
                  path={props.path}
                  directory={directory()}
                  text={draft()}
                  savedText={savedText()}
                  dirty={dirty()}
                  saving={saving()}
                  onChange={setDraft}
                  onSave={() => void save()}
                  onRaw={() => setShowSource(true)}
                />
              </Match>

              {/* tabular data */}
              <Match when={kind() === "table" && !showSource()}>
                <Show when={tabular()}>
                  {(format) => <DataTableView text={draft()} format={format()} name={name()} />}
                </Show>
              </Match>

              {/* genomic, alignment, and mass-spectrometry data */}
              <Match when={kind() === "scientific-data" && !showSource()}>
                <Show when={biological()}>
                  {(format) => <ScientificDataView text={draft()} format={format()} name={name()} />}
                </Show>
              </Match>

              {/* large scientific containers */}
              <Match when={kind() === "scientific-binary"}>
                <Show when={binaryScience()}>
                  {(format) => <BinaryScienceView path={props.path} directory={directory()} format={format()} />}
                </Show>
              </Match>

              {/* pdf */}
              <Match when={kind() === "pdf"}>
                <div style={{ padding: "14px" }}>
                  <PdfViewer kind="pdf" data={{ base64: b64(), maxPages: 40 }} height={100000} />
                </div>
              </Match>

              {/* image */}
              <Match when={kind() === "image"}>
                <div style={{ display: "grid", "place-items": "center", padding: "22px", "min-height": "100%" }}>
                  <img
                    src={dataUrl()}
                    alt={name()}
                    style={{
                      "max-width": "100%",
                      "max-height": "100%",
                      "object-fit": "contain",
                      "border-radius": "4px",
                    }}
                  />
                </div>
              </Match>

              {/* scientific file */}
              <Match when={kind() === "science" && !showSource()}>
                <Show when={scientific()}>
                  {(artifact) => (
                    <div
                      style={{
                        padding: "14px",
                        height: "100%",
                        "min-height": "420px",
                        "box-sizing": "border-box",
                      }}
                    >
                      <ScienceArtifact
                        kind={artifact().kind}
                        data={artifact().data}
                        height={560}
                        onInspect={setInspection}
                      />
                    </div>
                  )}
                </Show>
              </Match>

              {/* binary */}
              <Match when={kind() === "binary"}>
                <div
                  style={{
                    display: "grid",
                    "place-items": "center",
                    padding: "40px 24px",
                    "min-height": "100%",
                    "text-align": "center",
                  }}
                >
                  <div
                    style={{
                      "font-family": FONT_SANS,
                      "font-size": "13px",
                      color: "var(--color-text-muted)",
                      "line-height": 1.6,
                    }}
                  >
                    Binary file — no inline preview.
                    <br />
                    Use the download button above to open it.
                  </div>
                </div>
              </Match>

              {/* code / text — editable source, or highlighted read view */}
              <Match
                when={
                  (kind() === "code" ||
                    kind() === "markdown" ||
                    kind() === "science" ||
                    kind() === "scientific-data" ||
                    kind() === "notebook" ||
                    kind() === "table") &&
                  showSource()
                }
              >
                <textarea
                  aria-label="File source"
                  value={draft()}
                  spellcheck={false}
                  onInput={(ev) => setDraft(ev.currentTarget.value)}
                  class="atlas-scroll"
                  style={{
                    all: "unset",
                    "box-sizing": "border-box",
                    display: "block",
                    width: "100%",
                    "min-height": "100%",
                    padding: "16px 18px",
                    "font-family": FONT_CODE,
                    "font-size": "12px",
                    "line-height": 1.65,
                    color: "var(--color-text)",
                    "white-space": "pre",
                    "tab-size": 2,
                  }}
                />
              </Match>
              <Match when={kind() === "code"}>
                <div style={{ padding: "14px 16px" }}>
                  <Markdown
                    class="atlas-md"
                    text={fence(
                      showSource() && kind() !== "code" ? langFor(kind(), e()) : (LANG[e()] ?? "text"),
                      draft(),
                    )}
                  />
                </div>
              </Match>
            </Switch>
          </div>
        </Show>
      </Show>
    </div>
  )
}

/**
 * Slide-in drawer wrapper around FileView — kept for the legacy right-pane
 * preview path. Backdrop / Esc / the header × all close it.
 */
export function FilePreview(props: { path: string; onClose: () => void }): JSX.Element {
  const [mounted, setMounted] = createSignal(false)
  onMount(() => {
    requestAnimationFrame(() => setMounted(true))
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })
  return (
    <Portal>
      <div
        onClick={props.onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.42)",
          "backdrop-filter": "blur(2px)",
          "z-index": 90,
          opacity: mounted() ? 1 : 0,
          transition: "opacity 120ms ease",
        }}
      />
      <div
        role="dialog"
        aria-label={`preview ${props.path}`}
        style={{
          position: "fixed",
          top: "14px",
          bottom: "14px",
          right: "14px",
          width: "clamp(360px, 60vw, 820px)",
          "max-width": "calc(100vw - 28px)",
          display: "flex",
          "flex-direction": "column",
          background: "var(--color-surface-solid)",
          border: "1px solid var(--color-border-strong)",
          "border-radius": "4px",
          "box-shadow": "var(--shadow-lg, 0 24px 60px rgba(0,0,0,0.35))",
          overflow: "hidden",
          "z-index": 91,
          transform: mounted() ? "translateX(0)" : "translateX(16px)",
          opacity: mounted() ? 1 : 0,
          transition: "transform 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease",
        }}
      >
        <FileView path={props.path} onClose={props.onClose} />
      </div>
    </Portal>
  )
}

function langFor(k: Kind, x: string): string {
  if (k === "markdown") return "markdown"
  if (k === "notebook") return "json"
  if (k === "table") return x === "jsonl" ? "json" : x
  return LANG[x] ?? "text"
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// Wrap raw file text in a fenced code block so the shared Markdown renderer
// (marked + shiki) syntax-highlights it. Guards against content that already
// contains a triple backtick by widening the fence.
function fence(lang: string, body: string): string {
  let ticks = "```"
  while (body.includes(ticks)) ticks += "`"
  return `${ticks}${lang}\n${body}\n${ticks}`
}

function iconBtn(active = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: "28px",
    height: "28px",
    "border-radius": "4px",
    color: active ? "var(--color-text)" : "var(--color-text-faint)",
    background: active ? "var(--color-accent-subtle)" : "transparent",
    "flex-shrink": 0,
    transition: "background 120ms ease, color 120ms ease",
  } as JSX.CSSProperties
}

function retryBtn(): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    "margin-top": "2px",
    padding: "5px 12px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    color: "var(--color-text)",
  } as JSX.CSSProperties
}

function ctlBtn(primary = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    display: "inline-flex",
    "align-items": "center",
    padding: "5px 11px",
    "border-radius": "4px",
    border: primary ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
    background: primary ? "var(--color-text)" : "var(--color-bg-subtle)",
    color: primary ? "var(--color-bg)" : "var(--color-text-muted)",
    "font-family": FONT_MONO,
    "font-size": "11px",
    "font-weight": primary ? 600 : 500,
    "flex-shrink": 0,
  } as JSX.CSSProperties
}

export default FilePreview
