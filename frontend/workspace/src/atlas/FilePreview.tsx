import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  untrack,
  type JSX,
  Show,
  Switch,
  Match,
} from "solid-js"
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
  createFileRequestOwner,
  fileRequestKey,
  fileReadRetryDelay,
  initialFileScope,
  fileReadSession,
  fileErrorMessage,
  linkedFileTarget,
  isMissingFileError,
  missingFileFallback,
  PDF_PREVIEW_LIMIT,
  pdfPreviewMode,
  readFile,
  reconcileSavedDraft,
  type FileData,
  type FileKind,
  type FileOpenScope,
  type ResolvedFileScope,
} from "@/atlas/file-viewer"
import { LANG, extension as ext } from "@/atlas/files/artifact-thumb"
import { resolveViewer } from "@/atlas/files/viewer-registry"
import { assetUrl, localAssetPath } from "@/utils/markdown-assets"
import { discardFileDraft, recoverFileDraftState, rememberFileDraft } from "@/atlas/file-drafts"
import { MarkdownDocument } from "@/atlas/MarkdownDocument"
import { rawFileQuery } from "@/utils/project-file"
import { CodeEditor } from "@/atlas/CodeEditor"
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
  status: "loading" | "ready" | "interrupted" | "error"
  data?: FileData
  error?: Error
  saveError?: string
  revision?: string
  conflict?: boolean
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
  sessionID?: string
  scope?: FileOpenScope
  subtitle?: string
  onClose?: () => void
  active?: boolean
  writable?: boolean
  onDirtyChange?: (dirty: boolean) => void
  /** Explicit transport seam for embedding and component-level regression checks. */
  services?: Pick<ReturnType<typeof useSDK>, "request" | "client" | "projectID" | "url">
}): JSX.Element {
  const production = props.services ? undefined : useSDK()
  const sdk = props.services ?? production!
  const sync = props.services ? undefined : useSync()
  const params = props.services ? undefined : useParams()
  const directory = () =>
    props.directory || production?.directory || sync?.data.path.directory || sync?.project?.worktree || ""
  const activeSessionID = () => props.sessionID ?? (params?.id && params.id !== "new" ? params.id : undefined)
  const initialScope = () =>
    initialFileScope(props.scope, { directory: directory(), path: props.path, sessionID: activeSessionID() })
  const [resolvedScope, setResolvedScope] = createSignal<ResolvedFileScope>(initialScope())
  const [resolvedPath, setResolvedPath] = createSignal(props.path)
  const [resolvedWritable, setResolvedWritable] = createSignal<boolean>()
  let scopeIdentity = ""
  createEffect(() => {
    const next = [
      sdk.url,
      sdk.projectID,
      props.scope ?? "project",
      directory(),
      props.path,
      activeSessionID() ?? "",
    ].join("\n")
    if (next === scopeIdentity) return
    scopeIdentity = next
    setResolvedScope(initialScope())
    setResolvedPath(props.path)
    setResolvedWritable(undefined)
  })
  const requestPath = () =>
    resolvedScope() === "session" ? resolvedPath() : resolveArtifactPath(directory(), resolvedPath())
  const fileSessionID = () =>
    fileReadSession({
      scope: props.scope,
      resolved: resolvedScope(),
      directory: directory(),
      path: requestPath(),
      sessionID: activeSessionID(),
    })
  const name = () => resolvedPath().split("/").pop() || resolvedPath()
  const e = () => ext(name())
  const owner = createMemo(() => ({
    server: sdk.url,
    projectID: sdk.projectID,
    directory: directory(),
    sessionID: activeSessionID(),
    path: props.path,
    target: requestPath(),
    scope: props.scope,
  }))
  let mounted = true
  onCleanup(() => (mounted = false))

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
  const request = createFileRequestOwner()
  const readRetry = { key: "", count: 0 }
  let readyKey = ""
  let readyOwner: ReturnType<typeof owner> | undefined
  let readRetryTimer: ReturnType<typeof setTimeout> | undefined
  const pdfRequest = { current: 0 }
  const pdfAbort = { current: undefined as AbortController | undefined }
  const htmlRequest = { current: 0 }
  const htmlAbort = { current: undefined as AbortController | undefined }

  createEffect(() => {
    const dir = directory()
    const path = requestPath()
    const activeSession = fileSessionID()
    const location = owner()
    view.refresh
    const key = fileRequestKey({
      server: sdk.url,
      projectID: sdk.projectID,
      directory: dir,
      sessionID: activeSession,
      path,
    })
    if (readRetryTimer) {
      clearTimeout(readRetryTimer)
      readRetryTimer = undefined
    }
    if (readRetry.key !== key) {
      readRetry.key = key
      readRetry.count = 0
    }
    const ticket = request.begin(key)
    // Read completion and editor state are outputs, not request dependencies:
    // tracking them would launch another read when a refresh replaces data.
    const retained = untrack(() => readyOwner === location && readyKey === key && view.status === "ready" && view.data)
    if (retained) {
      // A reconnect or explicit refresh must not blank a valid preview. Keep
      // the rendered bytes and any unsaved draft while the replacement read
      // happens in the background.
      setView({ error: undefined })
    } else {
      readyKey = ""
      setView({
        status: "loading",
        data: undefined,
        error: undefined,
        saveError: undefined,
        source: false,
        draft: "",
        saved: "",
        saving: false,
        revision: undefined,
        conflict: false,
        inspection: undefined,
      })
    }
    if (!dir || !path) {
      setView({ status: "error", error: new Error("The file location is unavailable.") })
      return
    }
    // Keep the project directory as the backend instance boundary. External
    // absolute paths remain absolute and require a session filesystem grant.
    void readFile(async () => {
      const response = await sdk.client.file.read(
        { path, sessionID: activeSession },
        { signal: ticket.controller.signal },
      )
      const envelope = response as unknown as { data?: FileData }
      return envelope.data ?? (response as unknown as FileData)
    }).then((result) => {
      if (!request.owns(ticket, key) || owner() !== location) return
      if (result.cancelled) {
        const delay = fileReadRetryDelay(readRetry.count)
        if (delay !== undefined) {
          readRetry.count += 1
          readRetryTimer = setTimeout(() => {
            readRetryTimer = undefined
            if (request.owns(ticket, key)) setView("refresh", (value) => value + 1)
          }, delay)
        } else if (readyKey !== key || view.status !== "ready" || !view.data) {
          setView({ status: "interrupted", error: undefined, data: undefined })
        } else {
          // The last valid preview remains usable. Keep the transport detail in
          // diagnostics rather than replacing the document with an error card.
          console.warn("File preview transport remained interrupted after bounded retries", {
            requestID: ticket.id,
            requestKey: key,
            retries: readRetry.count,
          })
        }
        return
      }
      if (result.error) {
        const fallback = missingFileFallback({
          requested: props.scope ?? "project",
          resolved: resolvedScope(),
          error: result.error,
        })
        if (fallback) {
          setResolvedScope(fallback)
          return
        }
        const reference = resolvedPath()
        const session = activeSessionID()
        if (
          (props.scope ?? "project") === "auto" &&
          resolvedScope() === "project" &&
          session &&
          isMissingFileError(result.error)
        ) {
          const originalError = result.error
          void sdk
            .request("/file/resolve", { signal: ticket.controller.signal }, { path: reference, sessionID: session })
            .then(async (response) => {
              if (!request.owns(ticket, key) || owner() !== location) return
              if (!response.ok) throw new Error(await response.text())
              const resolved = (await response.json()) as { path?: unknown; writable?: unknown }
              if (!request.owns(ticket, key) || owner() !== location) return
              if (typeof resolved.path === "string" && resolved.path) {
                if (typeof resolved.writable === "boolean") setResolvedWritable(resolved.writable)
                setResolvedPath(resolved.path)
                return
              }
              setView({ status: "error", error: originalError, data: undefined })
            })
            .catch(() => {
              if (request.owns(ticket, key) && owner() === location)
                setView({ status: "error", error: originalError, data: undefined })
            })
          return
        }
        setView({ status: "error", error: result.error, data: undefined })
        return
      }
      const data = result.data ?? {}
      readRetry.count = 0
      const text = data.encoding === "base64" ? "" : (data.content ?? "")
      const recovered = recoverFileDraftState(
        dir,
        location.path,
        text,
        location.scope,
        location.sessionID,
        data.revision,
        location.server,
      )
      const conflict = recovered.draft !== recovered.saved && recovered.revision !== data.revision
      readyKey = key
      readyOwner = location
      setView({
        status: "ready",
        data,
        error: undefined,
        ...recovered,
        conflict,
        saveError: conflict
          ? "This file changed on disk. Your edits are preserved; copy them before discarding and reloading the latest file."
          : undefined,
      })
    })
  })

  onCleanup(() => {
    if (readRetryTimer) clearTimeout(readRetryTimer)
    request.dispose()
  })

  const data = () => view.data
  const writable = () => props.writable ?? resolvedWritable()
  const isBinary = () => data()?.encoding === "base64"
  const truncated = () => data()?.truncated === true
  const mime = () => data()?.mimeType ?? ""
  const b64 = () => data()?.content ?? ""
  const dataUrl = () => `data:${mime() || "application/octet-stream"};base64,${b64()}`
  const dirty = () => view.draft !== view.saved
  createEffect(() => props.onDirtyChange?.(dirty()))
  createEffect(() => {
    if (view.status !== "ready") return
    const location = owner()
    if (readyOwner !== location) return
    rememberFileDraft(
      location.directory,
      location.path,
      view.draft,
      view.saved,
      location.scope,
      location.sessionID,
      view.revision,
      location.server,
    )
  })
  const scientific = createMemo(() => (isBinary() ? undefined : detectScientificFile(e(), view.draft)))
  const biological = createMemo(() => (isBinary() ? undefined : detectBiologicalFormat(e())))
  const binaryScience = createMemo(() => detectBinaryScienceFormat(e()))
  const common = createMemo(() =>
    resolveViewer({ name: name(), mimeType: mime(), encoding: data()?.encoding, content: view.draft }),
  )
  const tabular = createMemo<TableFormat | undefined>(() => common().table)

  const kind = createMemo<Kind>(() => {
    if (isBinary()) {
      if (common().kind === "image") return "image"
      if (common().kind === "pdf") return "pdf"
      if (binaryScience()) return "scientific-binary"
      return "binary"
    }
    if (biological()) return "scientific-data"
    if (scientific()) return "science"
    if (common().kind === "markdown") return "markdown"
    if (common().kind === "html") return "html"
    if (common().kind === "table") return "table"
    if (common().kind === "pdf") return "pdf"
    if (common().kind === "image") return "image"
    if (common().kind === "binary") return "binary"
    // .tex / .latex / .sty / .cls are source files → highlighted "code" view
    // (LANG maps them to the shiki `latex` grammar). They are NEVER routed to
    // KaTeX, which blanks on a full \documentclass document.
    return "code"
  })
  const pdfMode = createMemo(() => pdfPreviewMode({ truncated: truncated(), size: data()?.size }))
  const manuscript = createMemo(() => parseManuscript(view.draft).bibliographies.length > 0)
  // Relative image references in previewed markdown resolve against the
  // file's own directory through the backend raw-file endpoint.
  const rawUrl = (path: string, dir = directory(), session = fileSessionID()) =>
    sdk.request.url(
      "/file/raw",
      rawFileQuery({ directory: dir, path, sessionID: session, scope: resolvedScope(), inline: true }),
    )
  const image = (src: string) =>
    assetUrl(src, {
      base: resolvedPath(),
      url: (path) => rawUrl(path),
    })
  const file = (href: string) => localAssetPath(href, resolvedPath())
  const openFile = (path: string) => {
    const target = linkedFileTarget({
      directory: directory(),
      path,
      scope: props.scope,
      resolved: resolvedScope(),
      sessionID: activeSessionID(),
    })
    uiStore.openFile(directory(), target.path, target)
  }
  const html = () => htmlView.value

  createEffect(() => {
    const source = view.draft
    const dir = directory()
    const session = fileSessionID()
    const base = resolvedPath()
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
          rawFileQuery({
            directory: dir,
            path,
            sessionID: session,
            scope: resolvedScope(),
            maxBytes: HTML_STYLESHEET_BYTES,
          }),
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
      path: resolvedPath(),
      format: badge(),
      scienceKind: scientific()?.kind,
      inspection: view.inspection,
    }),
  )

  createEffect(() => {
    const mode = kind() === "pdf" ? pdfMode() : "inline"
    const path = requestPath()
    const session = fileSessionID()
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
        rawFileQuery({
          directory: directory(),
          path,
          sessionID: session,
          scope: resolvedScope(),
          maxBytes: PDF_PREVIEW_LIMIT,
        }),
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
    if (view.status !== "ready" || view.saving || isBinary() || truncated() || !dirty() || view.conflict) return
    if (!view.revision) {
      setView(
        "saveError",
        "This server did not provide a file revision. Your edits are preserved. Update the server and reload before saving.",
      )
      return
    }
    if (writable() === false) {
      toast.error("read-only source", "Reconnect this location with Read & write access to change files.")
      return
    }
    const session = activeSessionID()
    if (!session) {
      toast.error("save unavailable", "Start a research session before changing workspace files.")
      return
    }
    const location = owner()
    const owns = () => mounted && owner() === location
    const path = requestPath()
    const content = view.draft
    const expectedRevision = view.revision
    const title = name()
    // A pending read must not replace the base revision after this write starts.
    request.dispose()
    setView({ saving: true, saveError: undefined })
    try {
      const res = await sdk.request("/file/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content, sessionID: session, expectedRevision }),
      })
      const payload = (await res.json().catch(() => undefined)) as FileData | undefined
      if (!res.ok) {
        if (res.status === 409 && owns()) setView("conflict", true)
        throw new Error(
          res.status === 409
            ? "This file changed on disk. Your edits are preserved; copy them before discarding and reloading the latest file."
            : payload
              ? fileErrorMessage(payload)
              : `Save failed (${res.status}). Your edits are preserved.`,
        )
      }
      if (!payload?.revision)
        throw new Error(
          "The server did not confirm the saved revision. Your edits are preserved; reload the file before trying again.",
        )
      const next = typeof payload.content === "string" ? payload.content : content
      const previous = recoverFileDraftState(
        location.directory,
        location.path,
        content,
        location.scope,
        location.sessionID,
        expectedRevision,
        location.server,
      )
      if (previous.revision === expectedRevision) {
        const settled = reconcileSavedDraft(previous.draft, content, next)
        rememberFileDraft(
          location.directory,
          location.path,
          settled.draft,
          settled.saved,
          location.scope,
          location.sessionID,
          payload.revision,
          location.server,
        )
      }
      if (!owns()) return
      setView({
        ...reconcileSavedDraft(view.draft, content, next),
        saving: false,
        saveError: undefined,
        revision: payload.revision,
        conflict: false,
        data: { ...view.data, content: next, revision: payload.revision },
      })
      toast.success("saved", title)
    } catch (error) {
      if (!owns()) return
      const message = error instanceof Error ? error.message : String(error)
      setView({ saving: false, saveError: message })
      toast.error("save failed", message)
    }
  }

  // Explicit save into the immutable artifact store — the backend reads the
  // file's bytes on disk (not the unsaved draft) and registers a durable,
  // versioned artifact with provenance.
  const [archiving, setArchiving] = createSignal(false)
  createEffect(() => {
    owner()
    setArchiving(false)
  })
  const artifact = async () => {
    if (archiving()) return
    if (dirty()) {
      toast.info("save file first", "Save your changes before creating an immutable Result version.")
      return
    }
    const session = activeSessionID()
    if (!session) {
      toast.error("artifact unavailable", "Open this file inside a research session to save artifacts.")
      return
    }
    const location = owner()
    const owns = () => mounted && owner() === location
    const title = name()
    setArchiving(true)
    try {
      const res = await sdk.request("/file/artifact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: requestPath(), sessionID: session }),
      })
      if (!res.ok) throw new Error(`artifact save failed (${res.status})`)
      const saved = normalizeStoredArtifact(await res.json().catch(() => undefined))
      if (!owns()) return
      window.dispatchEvent(new CustomEvent("openscience:artifacts-changed"))
      showToast({
        variant: "success",
        title: "Saved to Results",
        description: saved ? savedResultLabel(saved) : title,
        actions: saved
          ? [
              {
                label: "Open",
                onClick: () => {
                  if (owns()) uiStore.openSaved(saved)
                },
              },
            ]
          : undefined,
      })
    } catch (error) {
      if (!owns()) return
      toast.error("artifact save failed", error instanceof Error ? error.message : String(error))
    } finally {
      if (owns()) setArchiving(false)
    }
  }

  const copy = async () => {
    const location = owner()
    const title = name()
    try {
      await navigator.clipboard?.writeText(isBinary() ? dataUrl() : view.draft)
      if (mounted && owner() === location) toast.success("copied", title)
    } catch {}
  }

  const download = async () => {
    const location = owner()
    const title = name()
    try {
      const session = fileSessionID()
      const response = await sdk.request(
        "/file/raw",
        undefined,
        rawFileQuery({ directory: directory(), path: requestPath(), sessionID: session, scope: resolvedScope() }),
      )
      if (!response.ok) throw new Error(`download failed (${response.status})`)
      const blob = await response.blob()
      if (mounted && owner() === location) downloadBlob(title, blob)
    } catch (error) {
      if (!mounted || owner() !== location) return
      toast.error("download failed", error instanceof Error ? error.message : String(error))
    }
  }

  const location = () => {
    if (props.subtitle) return props.subtitle
    const path = resolvedPath()
    const index = path.lastIndexOf("/")
    return index > 0 ? path.slice(0, index) : resolvedScope() === "session" ? "Session files" : "Project files"
  }

  return (
    <div class="atlas-file-view" data-component="file-view" data-artifact-id={context().id}>
      <FileToolbar
        name={name()}
        location={location()}
        description={description()}
        source={view.source}
        sourceLabel={description().source && writable() !== false ? "Edit" : undefined}
        dirty={dirty()}
        saving={view.saving}
        saveDisabled={!view.revision || view.conflict === true}
        writable={writable()}
        disabled={view.status !== "ready"}
        artifact={Boolean(activeSessionID())}
        archiving={archiving()}
        onPreview={() => setView("source", false)}
        onSource={() => setView("source", true)}
        onDiscard={() => {
          discardFileDraft(directory(), props.path, props.scope, activeSessionID(), sdk.url)
          if (view.conflict) {
            setView({ conflict: false, saveError: undefined, draft: view.saved, refresh: view.refresh + 1 })
            return
          }
          setView({ draft: view.saved, saveError: undefined })
        }}
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
            <Show when={view.conflict}>
              <button
                type="button"
                class="atlas-file-button"
                onClick={() => {
                  discardFileDraft(directory(), props.path, props.scope, activeSessionID(), sdk.url)
                  setView({ draft: view.saved, conflict: false, saveError: undefined, refresh: view.refresh + 1 })
                }}
              >
                Discard changes and reload
              </button>
            </Show>
          </div>
        )}
      </Show>
      <Show
        when={
          view.status === "ready" &&
          !isBinary() &&
          !truncated() &&
          !view.revision &&
          !view.saveError &&
          writable() !== false
        }
      >
        <div class="atlas-file-save-error" role="status">
          Saving is unavailable because this server did not provide a file revision. Your edits are preserved; update
          the server and reload before saving.
        </div>
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
              <Show
                when={view.status === "interrupted"}
                fallback={
                  <section class="atlas-file-error" role="alert" aria-live="polite">
                    <IconFile size={20} strokeWidth={1.4} />
                    <h2>Couldn’t open this file</h2>
                    <p>{view.error?.message ?? "The file could not be read."}</p>
                    <button
                      type="button"
                      class="atlas-file-button"
                      onClick={() => setView("refresh", (key) => key + 1)}
                    >
                      Retry
                    </button>
                  </section>
                }
              >
                <section class="atlas-file-error" role="status" aria-live="polite">
                  <IconFile size={20} strokeWidth={1.4} />
                  <h2>File preview interrupted</h2>
                  <p>The read ended before it finished. Your file was not changed.</p>
                  <button
                    type="button"
                    class="atlas-file-button"
                    onClick={() => {
                      readRetry.count = 0
                      setView("refresh", (key) => key + 1)
                    }}
                  >
                    Retry
                  </button>
                </section>
              </Show>
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
                    sessionID={fileSessionID()}
                    scope={resolvedScope()}
                    openScope={props.scope}
                    text={view.draft}
                    dirty={dirty()}
                    saving={view.saving}
                    onChange={(draft) => {
                      if (writable() === false) return
                      setView({ draft, saveError: view.conflict ? view.saveError : undefined })
                    }}
                  />
                </Match>

                {/* ordinary Markdown opens as a quiet document */}
                <Match when={kind() === "markdown" && !view.source && !manuscript()}>
                  <MarkdownDocument
                    name={name()}
                    text={view.draft}
                    resolveImage={image}
                    resolveFile={file}
                    onOpenFile={openFile}
                  />
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
                        sessionID={fileSessionID()}
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
                  <CodeEditor
                    label={`${name()} source`}
                    value={view.draft}
                    language={LANG[e()] ?? "text"}
                    readOnly={writable() === false}
                    wrap={kind() === "markdown"}
                    onChange={(draft) => setView({ draft, saveError: view.conflict ? view.saveError : undefined })}
                    onSave={() => void save()}
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
