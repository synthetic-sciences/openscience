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
import { DataTableView } from "@/data/DataTableView"
import type { TableFormat } from "@/data/table"
import { ManuscriptWorkbench } from "@/manuscript/ManuscriptWorkbench"
import { parseManuscript } from "@/manuscript/model"
import { artifactContext, createArtifactContext, resolveArtifactPath } from "@/artifacts/context"
import { downloadBlob } from "@/artifacts/bytes"
import { normalizeStoredArtifact, savedResultLabel } from "@/artifacts/store"
import type { ArtifactInspection } from "@/science/renderers"
import { toast } from "@/atlas/Toast"
import { showToast } from "@synsci/ui/toast"
import { IconFile } from "@/atlas/shared/Icon"
import { FileToolbar } from "@/atlas/FileToolbar"
import { uiStore } from "@/atlas/store/ui"
import {
  describeFile,
  PDF_PREVIEW_LIMIT,
  pdfPreviewMode,
  readFile,
  reconcileSavedDraft,
  type FileData,
  type FileKind,
} from "@/atlas/file-viewer"
import { LANG, extension as ext } from "@/atlas/files/artifact-thumb"
import { assetUrl, localAssetPath } from "@/utils/markdown-assets"
import { recoverFileDraft, rememberFileDraft } from "@/atlas/file-drafts"
import { splitAlignedMarkdown } from "@/atlas/FilePreviewMarkdown"
import { rawFileQuery } from "@/utils/project-file"
import { HTML_STYLESHEET_BYTES, htmlStylesheets, loadHtmlStylesheets, rewriteHtmlAssets } from "@/utils/html-assets"
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

interface PdfState {
  status: "idle" | "loading" | "ready" | "error"
  bytes?: Uint8Array
  error?: string
}

interface HtmlState {
  status: "idle" | "loading" | "ready"
  value: string
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
  onDirtyChange?: (dirty: boolean) => void
}): JSX.Element {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const directory = () => props.directory || sdk.directory || sync.data.path.directory || sync.project?.worktree || ""
  const sessionID = () => (params.id && params.id !== "new" ? params.id : undefined)
  const requestPath = () => resolveArtifactPath(directory(), props.path)
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
  const [pdf, setPdf] = createStore<PdfState>({ status: "idle" })
  const [htmlView, setHtmlView] = createStore<HtmlState>({ status: "idle", value: "" })
  const request = { current: 0 }
  const pdfRequest = { current: 0 }
  const pdfAbort = { current: undefined as AbortController | undefined }
  const htmlRequest = { current: 0 }
  const htmlAbort = { current: undefined as AbortController | undefined }

  createEffect(() => {
    const dir = directory()
    const path = requestPath()
    const activeSession = sessionID()
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
      const response = await sdk.client.file.read({ path, sessionID: activeSession })
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
        draft: recoverFileDraft(dir, path, text),
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
  createEffect(() => props.onDirtyChange?.(dirty()))
  createEffect(() => {
    if (view.status !== "ready") return
    rememberFileDraft(directory(), props.path, view.draft, view.saved)
  })
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
    if (tabular()) return "table"
    if (biological()) return "scientific-data"
    if (x === "pdf") return "pdf"
    if (scientific()) return "science"
    // .tex / .latex / .sty / .cls are source files → highlighted "code" view
    // (LANG maps them to the shiki `latex` grammar). They are NEVER routed to
    // KaTeX, which blanks on a full \documentclass document.
    return "code"
  })
  const pdfMode = createMemo(() => pdfPreviewMode({ truncated: truncated(), size: data()?.size }))
  const manuscript = createMemo(() => parseManuscript(view.draft).bibliographies.length > 0)
  // Relative image references in previewed markdown resolve against the
  // file's own directory through the backend raw-file endpoint.
  const rawUrl = (path: string, dir = directory(), session = sessionID()) =>
    sdk.request.url("/file/raw", rawFileQuery({ directory: dir, path, sessionID: session, inline: true }))
  const image = (src: string) =>
    assetUrl(src, {
      base: props.path,
      url: (path) => rawUrl(path),
    })
  const file = (href: string) => localAssetPath(href, props.path)
  const openFile = (path: string) => uiStore.openFile(directory(), path)
  const html = () => htmlView.value

  createEffect(() => {
    const source = view.draft
    const dir = directory()
    const session = sessionID()
    const base = props.path
    const active = view.status === "ready" && kind() === "html" && !view.source
    const id = ++htmlRequest.current
    htmlAbort.current?.abort()
    htmlAbort.current = undefined
    if (!active) {
      setHtmlView("status", "idle")
      return
    }
    const url = (path: string) => rawUrl(path, dir, session)
    const resolve = (value: string) => assetUrl(value, { base, url })
    const fallback = rewriteHtmlAssets(source, resolve)
    setHtmlView({ status: "loading", value: fallback })
    const local = (href: string) => localAssetPath(href, base) !== undefined
    if (!htmlStylesheets(source).some(local)) {
      setHtmlView("status", "ready")
      return
    }
    const controller = new AbortController()
    htmlAbort.current = controller
    void loadHtmlStylesheets(
      source,
      async (href) => {
        const path = localAssetPath(href, base)
        if (!path) return
        const response = await sdk.request(
          "/file/raw",
          { signal: controller.signal },
          rawFileQuery({ directory: dir, path, sessionID: session, maxBytes: HTML_STYLESHEET_BYTES }),
        )
        if (!response.ok) return
        return response.text()
      },
      local,
      (stylesheet, value) => localAssetPath(value, stylesheet),
    ).then(
      (stylesheets) => {
        if (htmlRequest.current !== id || controller.signal.aborted) return
        setHtmlView({
          status: "ready",
          value: rewriteHtmlAssets(source, resolve, {
            stylesheets,
            resolveStylesheetPath: (stylesheet, value) => localAssetPath(value, stylesheet),
            resolveStylesheet: (stylesheet, value) => {
              const path = localAssetPath(stylesheet, base)
              return path ? assetUrl(value, { base: path, url }) : resolve(value)
            },
          }),
        })
      },
      () => {
        if (htmlRequest.current !== id || controller.signal.aborted) return
        setHtmlView("status", "ready")
      },
    )
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
  const markdown = createMemo(() => splitAlignedMarkdown(view.draft))

  createEffect(() => {
    const mode = kind() === "pdf" ? pdfMode() : "inline"
    const path = requestPath()
    const session = sessionID()
    const id = ++pdfRequest.current
    pdfAbort.current?.abort()
    pdfAbort.current = undefined
    setPdf({ status: "idle", bytes: undefined, error: undefined })
    if (view.status !== "ready" || mode !== "raw" || !path) return
    const controller = new AbortController()
    pdfAbort.current = controller
    setPdf({ status: "loading" })
    void sdk
      .request(
        "/file/raw",
        { signal: controller.signal },
        rawFileQuery({ directory: directory(), path, sessionID: session, maxBytes: PDF_PREVIEW_LIMIT }),
      )
      .then(async (response) => {
        if (response.ok) return new Uint8Array(await response.arrayBuffer())
        const detail = (await response.text().catch(() => "")).trim()
        throw new Error(detail || `PDF preview failed (${response.status})`)
      })
      .then(
        (bytes) => {
          if (pdfRequest.current !== id || controller.signal.aborted) return
          setPdf({ status: "ready", bytes, error: undefined })
        },
        (error: unknown) => {
          if (pdfRequest.current !== id || controller.signal.aborted) return
          setPdf({
            status: "error",
            bytes: undefined,
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
  })

  createEffect(() => {
    const current = context()
    if (props.active === false) {
      artifactContext.clear(current.id)
      return
    }
    artifactContext.activate(current)
  })

  onCleanup(() => artifactContext.clear(context().id))
  onCleanup(() => {
    pdfRequest.current += 1
    pdfAbort.current?.abort()
    htmlRequest.current += 1
    htmlAbort.current?.abort()
  })

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
    const path = requestPath()
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
      setView({
        ...reconcileSavedDraft(view.draft, content, next),
        saving: false,
        saveError: undefined,
      })
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
    if (dirty()) {
      toast.info("save file first", "Save your changes before creating an immutable Result version.")
      return
    }
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
        body: JSON.stringify({ path: requestPath(), sessionID: session }),
      })
      if (!res.ok) throw new Error(`artifact save failed (${res.status})`)
      const saved = normalizeStoredArtifact(await res.json().catch(() => undefined))
      window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
      showToast({
        variant: "success",
        title: "Saved to Results",
        description: saved ? savedResultLabel(saved) : name(),
        actions: saved
          ? [
              {
                label: "Open",
                onClick: () => uiStore.openSaved(saved),
              },
            ]
          : undefined,
      })
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
      const response = await sdk.request(
        "/file/raw",
        undefined,
        rawFileQuery({ directory: directory(), path: requestPath(), sessionID: session }),
      )
      if (!response.ok) throw new Error(`download failed (${response.status})`)
      downloadBlob(name(), await response.blob())
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
        sourceLabel={description().source && props.writable !== false ? "Edit" : undefined}
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
            <div
              class="atlas-scroll atlas-file-scroll"
              classList={{
                "is-managed-scroll": !view.source && (kind() === "table" || kind() === "pdf"),
                "is-editor-scroll": view.source,
              }}
            >
              <Switch>
                <Match when={truncated() && kind() !== "pdf"}>
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
                    path={requestPath()}
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
                    <Show
                      when={markdown().lead}
                      fallback={
                        <Markdown
                          class="atlas-md"
                          text={view.draft}
                          resolveImage={image}
                          resolveFile={file}
                          onOpenFile={openFile}
                        />
                      }
                    >
                      {(lead) => (
                        <>
                          <div class="atlas-file-document-lead" data-align={lead().alignment}>
                            <Markdown
                              class="atlas-md"
                              text={lead().text}
                              resolveImage={image}
                              resolveFile={file}
                              onOpenFile={openFile}
                            />
                          </div>
                          <Show when={markdown().rest}>
                            {(rest) => (
                              <Markdown
                                class="atlas-md"
                                text={rest()}
                                resolveImage={image}
                                resolveFile={file}
                                onOpenFile={openFile}
                              />
                            )}
                          </Show>
                        </>
                      )}
                    </Show>
                  </article>
                </Match>

                {/* HTML documents render fully sandboxed — no scripts, no same-origin access */}
                <Match when={kind() === "html" && !view.source}>
                  <div class="atlas-file-html">
                    <iframe class="atlas-file-html-frame" sandbox="" srcdoc={html()} title={name()} />
                  </div>
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
                        path={requestPath()}
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
                    <Switch>
                      <Match when={pdfMode() === "inline"}>
                        <PdfViewer kind="pdf" data={{ base64: b64(), maxPages: 40 }} />
                      </Match>
                      <Match when={pdfMode() === "raw" && pdf.status === "ready"}>
                        <Show when={pdf.bytes}>
                          {(bytes) => <PdfViewer kind="pdf" data={{ bytes: bytes(), maxPages: 40 }} />}
                        </Show>
                      </Match>
                      <Match when={pdfMode() === "raw" && pdf.status === "loading"}>
                        <div class="atlas-file-loading" role="status" aria-live="polite">
                          <div class="atlas-file-loading-heading" />
                          <div class="atlas-file-loading-line" />
                          <div class="atlas-file-loading-line is-short" />
                          <span>Loading the complete {formatBytes(data()?.size ?? 0)} PDF…</span>
                        </div>
                      </Match>
                      <Match when={pdfMode() === "raw" && pdf.status === "error"}>
                        <div class="atlas-file-notice" role="alert">
                          Couldn’t load the PDF preview. {pdf.error} Use Download above to open the original file.
                        </div>
                      </Match>
                      <Match when={pdfMode() === "download"}>
                        <div class="atlas-file-notice" role="status">
                          This {formatBytes(data()?.size ?? 0)} PDF exceeds the {formatBytes(PDF_PREVIEW_LIMIT)} browser
                          preview limit. Use Download above to open the original file.
                        </div>
                      </Match>
                    </Switch>
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
                      kind() === "table") &&
                    view.source
                  }
                >
                  <textarea
                    aria-label="File source"
                    value={view.draft}
                    readOnly={props.writable === false}
                    spellcheck={false}
                    wrap={kind() === "markdown" ? "soft" : "off"}
                    onInput={(event) => setView({ draft: event.currentTarget.value, saveError: undefined })}
                    class="atlas-scroll atlas-file-source-editor"
                    classList={{ "is-prose-editor": kind() === "markdown" }}
                    onKeyDown={(event) => {
                      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return
                      event.preventDefault()
                      void save()
                    }}
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
