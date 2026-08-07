import { createSignal, createEffect, createMemo, onMount, onCleanup, type JSX, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { Markdown } from "@synsci/ui/markdown"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
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
import { IconFile } from "@/atlas/shared/Icon"
import { FileToolbar } from "@/atlas/FileToolbar"
import { describeFile, readFile, type FileData, type FileKind } from "@/atlas/file-viewer"
import { LANG, extension as ext } from "@/atlas/files/artifact-thumb"
import { assetUrl } from "@/utils/markdown-assets"
import "./FilePreview.css"

/**
 * Slide-in SIDE PREVIEW pane for opening a file from the Files tree.
 *
 * A file's extension picks the renderer:
 *   .md / .markdown  → formatted markdown (@synsci/ui Markdown); relative
 *                      images resolve against the file's own directory via
 *                      the backend /file/raw endpoint
 *   .html / .htm     → sandboxed <iframe sandbox=""> document preview (no
 *                      scripts, no same-origin access), with a Source toggle
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

type Kind = FileKind

interface ViewState {
  source: boolean
  draft: string
  saved: string
  saving: boolean
  refresh: number
  status: "loading" | "ready" | "error"
  data?: FileData
  error?: Error
  saveError?: string
  inspection?: ArtifactInspection
}

/**
 * Inline file view — header (icon + name + subtitle + controls) over the
 * type-aware renderer body. This is the single source of truth for the
 * renderer dispatch; both the contextual Files pane and the legacy slide-in
 * drawer (FilePreview, below) mount it, so file rendering stays consistent.
 */
export function FileView(props: {
  path: string
  directory?: string
  subtitle?: string
  onClose?: () => void
  active?: boolean
  writable?: boolean
}): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const directory = () => props.directory || sdk.directory || sync.data.path.directory || sync.project?.worktree || ""
  const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)
  const name = () => props.path.split("/").pop() || props.path
  const e = () => ext(name())

  const [view, setView] = createStore<ViewState>({
    source: false,
    draft: "",
    saved: "",
    saving: false,
    refresh: 0,
    status: "loading",
  })
  const request = { current: 0 }

  createEffect(() => {
    const dir = directory()
    const path = props.path
    view.refresh
    const id = ++request.current
    setView({
      status: "loading",
      data: undefined,
      error: undefined,
      saveError: undefined,
      source: false,
      draft: "",
      saved: "",
      saving: false,
      inspection: undefined,
    })
    if (!dir || !path) {
      setView({ status: "error", error: new Error("The file location is unavailable.") })
      return
    }
    // Keep the project directory as the backend instance boundary. External
    // absolute paths remain absolute and require a session filesystem grant.
    void readFile(async () => {
      const response = await sdk.client.file.read({ path, sessionID: sessionID() })
      const envelope = response as unknown as { data?: FileData }
      return envelope.data ?? (response as unknown as FileData)
    }).then((result) => {
      if (request.current !== id) return
      if (result.error) {
        setView({ status: "error", error: result.error, data: undefined })
        return
      }
      const data = result.data ?? {}
      const text = data.encoding === "base64" ? "" : (data.content ?? "")
      setView({
        status: "ready",
        data,
        error: undefined,
        draft: text,
        saved: text,
      })
    })
  })

  onCleanup(() => {
    request.current += 1
  })

  const data = () => view.data
  const isBinary = () => data()?.encoding === "base64"
  const truncated = () => data()?.truncated === true
  const mime = () => data()?.mimeType ?? ""
  const b64 = () => data()?.content ?? ""
  const dataUrl = () => `data:${mime() || "application/octet-stream"};base64,${b64()}`
  const dirty = () => view.draft !== view.saved
  const scientific = createMemo(() => (isBinary() ? undefined : detectScientificFile(e(), view.draft)))
  const biological = createMemo(() => (isBinary() ? undefined : detectBiologicalFormat(e())))
  const binaryScience = createMemo(() => detectBinaryScienceFormat(e()))
  const tabular = createMemo<TableFormat | undefined>(() => {
    if (isBinary()) return
    if (e() === "csv" || e() === "tsv" || e() === "jsonl") return e() as TableFormat
    if (e() === "json" && view.draft.trimStart().startsWith("[")) return "json"
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
    if (x === "html" || x === "htm") return "html"
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
  const manuscript = createMemo(() => parseManuscript(view.draft).bibliographies.length > 0)
  // Relative image references in previewed markdown resolve against the
  // file's own directory through the backend raw-file endpoint.
  const image = (src: string) =>
    assetUrl(src, {
      base: props.path,
      url: (path) => sdk.request.url("/file/raw", { path, sessionID: sessionID() }),
    })

  const badge = () => {
    const k = kind()
    if (k === "code") return e() || "text"
    if (k === "science") return scientific()?.format ?? e()
    if (k === "scientific-data") return biological() ?? e()
    if (k === "scientific-binary") return binaryScience() ?? e()
    if (k === "table") return tabular() ?? e()
    return e() || k
  }
  const description = createMemo(() =>
    describeFile({
      kind: kind(),
      format: badge(),
      binary: isBinary(),
      truncated: truncated(),
    }),
  )
  const context = createMemo(() =>
    createArtifactContext({
      directory: directory(),
      path: props.path,
      format: badge(),
      scienceKind: scientific()?.kind,
      inspection: view.inspection,
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

  const save = async () => {
    if (view.saving || isBinary() || truncated() || !dirty()) return
    if (props.writable === false) {
      toast.error("read-only source", "Reconnect this location with Read & write access to change files.")
      return
    }
    const session = sessionID()
    if (!session) {
      toast.error("save unavailable", "Start a research session before changing workspace files.")
      return
    }
    const id = request.current
    const path = props.path
    const content = view.draft
    const title = name()
    setView({ saving: true, saveError: undefined })
    try {
      const res = await sdk.request("/file/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content, sessionID: session }),
      })
      if (!res.ok) throw new Error(`save failed (${res.status})`)
      const payload = (await res.json().catch(() => ({}))) as unknown
      const saved =
        payload && typeof payload === "object" && "content" in payload
          ? (payload as { content?: unknown }).content
          : undefined
      if (request.current !== id) return
      const next = typeof saved === "string" ? saved : content
      setView({ draft: next, saved: next, saving: false, saveError: undefined })
      toast.success("saved", title)
    } catch (error) {
      if (request.current !== id) return
      const message = error instanceof Error ? error.message : String(error)
      setView({ saving: false, saveError: message })
      toast.error("save failed", message)
    }
  }

  // Explicit save into the immutable artifact store — the backend reads the
  // file's bytes on disk (not the unsaved draft) and registers a durable,
  // versioned artifact with provenance.
  const [archiving, setArchiving] = createSignal(false)
  const artifact = async () => {
    if (archiving()) return
    const session = sessionID()
    if (!session) {
      toast.error("artifact unavailable", "Open this file inside a research session to save artifacts.")
      return
    }
    setArchiving(true)
    try {
      const res = await sdk.request("/file/artifact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: props.path, sessionID: session }),
      })
      if (!res.ok) throw new Error(`artifact save failed (${res.status})`)
      const ref = (await res.json()) as { current?: { version?: number } }
      window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
      toast.success("saved as artifact", `${name()} · v${ref.current?.version ?? 1}`)
    } catch (error) {
      toast.error("artifact save failed", error instanceof Error ? error.message : String(error))
    } finally {
      setArchiving(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(isBinary() ? dataUrl() : view.draft)
      toast.success("copied", name())
    } catch {}
  }

  const download = async () => {
    try {
      const session = sessionID()
      const response = await sdk.request("/file/raw", undefined, {
        path: props.path,
        sessionID: session,
      })
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

  const location = () => {
    if (props.subtitle) return props.subtitle
    const index = props.path.lastIndexOf("/")
    return index > 0 ? props.path.slice(0, index) : "Session files"
  }

  return (
    <div class="atlas-file-view" data-component="file-view" data-artifact-id={context().id}>
      <FileToolbar
        name={name()}
        location={location()}
        description={description()}
        source={view.source}
        dirty={dirty()}
        saving={view.saving}
        writable={props.writable}
        disabled={view.status !== "ready"}
        artifact={Boolean(sessionID())}
        archiving={archiving()}
        onPreview={() => setView("source", false)}
        onSource={() => setView("source", true)}
        onDiscard={() => setView({ draft: view.saved, saveError: undefined })}
        onSave={() => void save()}
        onArtifact={() => void artifact()}
        onCopy={() => void copy()}
        onDownload={() => void download()}
        onClose={props.onClose}
      />

      <Show when={view.saveError}>
        {(error) => (
          <div class="atlas-file-save-error" role="alert">
            Couldn’t save changes. {error()}
          </div>
        )}
      </Show>

      <div class="atlas-file-body" data-slot="file-body">
        <Show
          when={view.status !== "loading"}
          fallback={
            <div class="atlas-file-loading" role="status" aria-live="polite">
              <div class="atlas-file-loading-heading" />
              <div class="atlas-file-loading-line" />
              <div class="atlas-file-loading-line is-short" />
              <span>Loading {name()}…</span>
            </div>
          }
        >
          <Show
            when={view.status === "ready"}
            fallback={
              <section class="atlas-file-error" role="alert" aria-live="polite">
                <IconFile size={20} strokeWidth={1.4} />
                <h2>Couldn’t open this file</h2>
                <p>{view.error?.message ?? "The file could not be read."}</p>
                <button type="button" class="atlas-file-button" onClick={() => setView("refresh", (key) => key + 1)}>
                  Retry
                </button>
              </section>
            }
          >
            <div class="atlas-scroll atlas-file-scroll">
              <Switch>
                <Match when={truncated()}>
                  <div class="atlas-file-source atlas-file-truncated">
                    <div class="atlas-file-notice" role="status">
                      Preview limited to 8 MB of {formatBytes(data()?.size ?? 0)}. Download the file or use a compute
                      tool for the complete dataset.
                    </div>
                    <pre>{view.draft}</pre>
                  </div>
                </Match>
                {/* citation-aware manuscripts keep the research authoring workbench */}
                <Match when={kind() === "markdown" && !view.source && manuscript()}>
                  <ManuscriptWorkbench
                    directory={directory()}
                    path={props.path}
                    text={view.draft}
                    dirty={dirty()}
                    saving={view.saving}
                    onChange={(draft) => {
                      if (props.writable === false) return
                      setView({ draft, saveError: undefined })
                    }}
                  />
                </Match>

                {/* ordinary Markdown opens as a quiet document */}
                <Match when={kind() === "markdown" && !view.source && !manuscript()}>
                  <article class="atlas-file-document">
                    <Markdown class="atlas-md" text={view.draft} resolveImage={image} />
                  </article>
                </Match>

                {/* HTML documents render fully sandboxed — no scripts, no same-origin access */}
                <Match when={kind() === "html" && !view.source}>
                  <div class="atlas-file-html">
                    <iframe class="atlas-file-html-frame" sandbox="" srcdoc={view.draft} title={name()} />
                  </div>
                </Match>

                {/* notebook */}
                <Match when={kind() === "notebook" && !view.source}>
                  <NotebookView
                    path={props.path}
                    directory={directory()}
                    text={view.draft}
                    savedText={view.saved}
                    dirty={dirty()}
                    saving={view.saving}
                    onChange={(draft) => {
                      if (props.writable === false) return
                      setView({ draft, saveError: undefined })
                    }}
                    onSave={() => void save()}
                    onRaw={() => setView("source", true)}
                  />
                </Match>

                {/* tabular data */}
                <Match when={kind() === "table" && !view.source}>
                  <Show when={tabular()}>
                    {(format) => <DataTableView text={view.draft} format={format()} name={name()} />}
                  </Show>
                </Match>

                {/* genomic, alignment, and mass-spectrometry data */}
                <Match when={kind() === "scientific-data" && !view.source}>
                  <Show when={biological()}>
                    {(format) => <ScientificDataView text={view.draft} format={format()} name={name()} />}
                  </Show>
                </Match>

                {/* large scientific containers */}
                <Match when={kind() === "scientific-binary"}>
                  <Show when={binaryScience()}>
                    {(format) => (
                      <BinaryScienceView
                        path={props.path}
                        directory={directory()}
                        sessionID={sessionID()}
                        format={format()}
                      />
                    )}
                  </Show>
                </Match>

                {/* pdf */}
                <Match when={kind() === "pdf"}>
                  <div class="atlas-file-pdf">
                    <PdfViewer kind="pdf" data={{ base64: b64(), maxPages: 40 }} height={100000} />
                  </div>
                </Match>

                {/* image */}
                <Match when={kind() === "image"}>
                  <div class="atlas-file-image">
                    <img src={dataUrl()} alt={name()} />
                  </div>
                </Match>

                {/* scientific file */}
                <Match when={kind() === "science" && !view.source}>
                  <Show when={scientific()}>
                    {(artifact) => (
                      <div class="atlas-file-science">
                        <ScienceArtifact
                          kind={artifact().kind}
                          data={artifact().data}
                          height={560}
                          onInspect={(inspection) => setView("inspection", inspection)}
                        />
                      </div>
                    )}
                  </Show>
                </Match>

                {/* binary */}
                <Match when={kind() === "binary"}>
                  <div class="atlas-file-empty">
                    <div>
                      Binary file — no inline preview.
                      <br />
                      Use Download to open it in another application.
                    </div>
                  </div>
                </Match>

                {/* code / text — editable source, or highlighted read view */}
                <Match
                  when={
                    (kind() === "code" ||
                      kind() === "markdown" ||
                      kind() === "html" ||
                      kind() === "science" ||
                      kind() === "scientific-data" ||
                      kind() === "notebook" ||
                      kind() === "table") &&
                    view.source
                  }
                >
                  <textarea
                    aria-label="File source"
                    value={view.draft}
                    readOnly={props.writable === false}
                    spellcheck={false}
                    onInput={(event) => setView({ draft: event.currentTarget.value, saveError: undefined })}
                    class="atlas-scroll atlas-file-source-editor"
                  />
                </Match>
                <Match when={kind() === "code"}>
                  <div class="atlas-file-code">
                    <Markdown class="atlas-md" text={fence(LANG[e()] ?? "text", view.draft)} />
                  </div>
                </Match>
              </Switch>
            </div>
          </Show>
        </Show>
      </div>
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

export default FilePreview
