import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { ArtifactRenderProps } from "../registry"
import "./PdfViewer.css"

/**
 * `pdf` renderer — rasterizes PDF pages to <canvas> with pdfjs-dist.
 *
 * The document and worker remain lazy-loaded. Page canvases are rerendered at
 * the requested scale, and fit-width mode observes the actual preview viewport
 * so a PDF follows the resizable inspector rather than the browser window.
 */

interface PdfData {
  url?: string
  bytes?: ArrayBuffer | Uint8Array
  base64?: string
  scale: number
  maxPages: number
}

type Zoom = "fit" | number

interface PdfViewState {
  error?: string
  status: string
  pages?: { total: number; shown: number; rendered: number }
  zoom: Zoom
  currentPage: number
  rendering: boolean
  viewportWidth: number
  fitScale: number
}

const ZOOM_LEVELS = [0.35, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5]

function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(",")
  const raw = input.startsWith("data:") && comma !== -1 ? input.slice(comma + 1) : input
  const bin = atob(raw.trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function normalize(data: unknown): PdfData {
  const base: Pick<PdfData, "scale" | "maxPages"> = { scale: 1.35, maxPages: 12 }
  if (typeof data === "string") {
    if (data.startsWith("data:")) return { ...base, bytes: decodeBase64(data) }
    return { ...base, url: data }
  }
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>
    const scale = typeof d.scale === "number" && d.scale > 0 ? d.scale : base.scale
    const maxPages = typeof d.maxPages === "number" && d.maxPages > 0 ? Math.floor(d.maxPages) : base.maxPages
    if (typeof d.url === "string") return { url: d.url, scale, maxPages }
    if (d.bytes instanceof Uint8Array || d.bytes instanceof ArrayBuffer) return { bytes: d.bytes, scale, maxPages }
    if (d.data instanceof Uint8Array || d.data instanceof ArrayBuffer)
      return { bytes: d.data as ArrayBuffer | Uint8Array, scale, maxPages }
    if (typeof d.base64 === "string") return { base64: d.base64, scale, maxPages }
  }
  return { ...base }
}

interface PdfViewport {
  width: number
  height: number
}
interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): {
    promise: Promise<void>
    cancel(): void
  }
}
interface PdfDoc {
  numPages: number
  getPage(n: number): Promise<PdfPage>
}
interface PdfLoadingTask {
  promise: Promise<PdfDoc>
  destroy(): Promise<void>
}
interface PdfLib {
  getDocument(src: Record<string, unknown>): PdfLoadingTask
  GlobalWorkerOptions: { workerSrc: string }
}

export function PdfViewer(props: ArtifactRenderProps) {
  let viewport!: HTMLDivElement
  let host!: HTMLDivElement
  const cfg = normalize(props.data)
  const hasSource = Boolean(cfg.url || cfg.bytes || cfg.base64)
  const [view, setView] = createStore<PdfViewState>({
    status: hasSource ? "Loading PDF…" : "",
    zoom: "fit",
    currentPage: 1,
    rendering: false,
    viewportWidth: 0,
    fitScale: 1,
  })

  let requestRender = () => {}
  let goToPage = (_page: number) => {}

  const zoomLabel = () => (view.zoom === "fit" ? "Fit" : `${Math.round((view.zoom as number) * 100)}%`)
  const changeZoom = (direction: -1 | 1) => {
    const value = view.zoom
    const base = value === "fit" ? view.fitScale : value
    const index =
      direction > 0
        ? ZOOM_LEVELS.findIndex((level) => level > base + 0.01)
        : ZOOM_LEVELS.findLastIndex((level) => level < base - 0.01)
    const fallback = direction > 0 ? ZOOM_LEVELS.length - 1 : 0
    setView("zoom", ZOOM_LEVELS[index < 0 ? fallback : index] ?? 1)
    requestRender()
  }

  onMount(() => {
    let loadingTask: PdfLoadingTask | undefined
    let doc: PdfDoc | undefined
    let disposed = false
    let renderVersion = 0
    let renderFrame = 0
    let scrollFrame = 0
    let lastFitWidth = 0
    let pageNodes: HTMLElement[] = []
    let tasks: Array<{ cancel(): void }> = []

    const cancelTasks = () => {
      for (const task of tasks) {
        try {
          task.cancel()
        } catch {
          // A task may already be complete.
        }
      }
      tasks = []
    }

    const dispose = () => {
      cancelTasks()
      try {
        void loadingTask?.destroy?.().catch?.(() => {
          // Ignore teardown races from pdfjs.
        })
      } catch {
        // Cleanup must never throw into Solid's owner disposal.
      }
    }

    const renderPages = async () => {
      if (!doc || disposed || !host) return
      const version = ++renderVersion
      const restorePage = view.currentPage
      cancelTasks()
      setView({ rendering: true, error: undefined })
      host.replaceChildren()
      pageNodes = []

      const total = doc.numPages
      const shown = Math.min(total, cfg.maxPages)
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
      const available = Math.max(240, view.viewportWidth - 32)
      setView("pages", { total, shown, rendered: 0 })

      for (let n = 1; n <= shown; n++) {
        if (disposed || version !== renderVersion) return
        const page = await doc.getPage(n)
        if (disposed || version !== renderVersion) return
        const natural = page.getViewport({ scale: 1 })
        const fitScale = Math.max(0.35, Math.min(2.5, available / Math.max(1, natural.width)))
        if (n === 1) setView("fitScale", fitScale)
        const scale = view.zoom === "fit" ? fitScale : (view.zoom as number)
        const size = page.getViewport({ scale })

        const frame = document.createElement("section")
        frame.className = "pdf-viewer-page"
        frame.dataset.page = String(n)
        frame.setAttribute("role", "group")
        frame.setAttribute("aria-label", `Page ${n} of ${total}`)

        const canvas = document.createElement("canvas")
        canvas.width = Math.max(1, Math.floor(size.width * dpr))
        canvas.height = Math.max(1, Math.floor(size.height * dpr))
        canvas.style.width = `${Math.floor(size.width)}px`
        canvas.style.height = `${Math.floor(size.height)}px`
        canvas.setAttribute("aria-label", `Rendered PDF page ${n}`)

        const label = document.createElement("span")
        label.className = "pdf-viewer-page-number"
        label.textContent = `${n}`
        label.setAttribute("aria-hidden", "true")

        frame.append(canvas, label)
        host.appendChild(frame)
        pageNodes.push(frame)

        const context = canvas.getContext("2d")
        if (!context) continue
        if (dpr !== 1) context.scale(dpr, dpr)
        const task = page.render({ canvasContext: context, viewport: size })
        tasks.push(task)
        try {
          await task.promise
        } catch {
          if (disposed || version !== renderVersion) return
        }
        if (disposed || version !== renderVersion) return
        setView("pages", { total, shown, rendered: n })
      }

      if (!disposed && version === renderVersion) {
        setView("rendering", false)
        goToPage(restorePage)
      }
    }

    requestRender = () => {
      if (disposed) return
      cancelAnimationFrame(renderFrame)
      renderFrame = requestAnimationFrame(() => void renderPages())
    }

    goToPage = (page) => {
      const count = view.pages?.shown ?? 1
      const next = Math.max(1, Math.min(count, page))
      const target = pageNodes[next - 1]
      if (!target || !viewport) return
      viewport.scrollTo({ top: Math.max(0, target.offsetTop - 12), behavior: "auto" })
      setView("currentPage", next)
    }

    const onScroll = () => {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(() => {
        const top = viewport.scrollTop + 24
        let current = 1
        for (const node of pageNodes) {
          if (node.offsetTop > top) break
          current = Number(node.dataset.page ?? current)
        }
        setView("currentPage", current)
      })
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })

    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            const width = Math.floor(entry?.contentRect.width ?? 0)
            if (!width) return
            setView("viewportWidth", width)
            if (view.zoom !== "fit" || Math.abs(width - lastFitWidth) < 6) return
            lastFitWidth = width
            requestRender()
          })
    if (observer) observer.observe(viewport)
    else setView("viewportWidth", 640)

    if (hasSource) {
      ;(async () => {
        try {
          const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfLib
          if (!pdfjs.GlobalWorkerOptions.workerSrc) {
            const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default
            pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
          }

          const src: Record<string, unknown> = cfg.url
            ? { url: cfg.url }
            : { data: cfg.bytes ?? decodeBase64(cfg.base64 ?? "") }
          loadingTask = pdfjs.getDocument(src)
          const loaded = await loadingTask.promise
          if (disposed) {
            dispose()
            return
          }
          doc = loaded
          setView({
            status: "",
            pages: { total: loaded.numPages, shown: Math.min(loaded.numPages, cfg.maxPages), rendered: 0 },
          })
          requestRender()
        } catch (cause) {
          if (disposed) return
          setView({
            status: "",
            rendering: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })()
    }

    onCleanup(() => {
      disposed = true
      requestRender = () => {}
      goToPage = () => {}
      observer?.disconnect()
      viewport.removeEventListener("scroll", onScroll)
      cancelAnimationFrame(renderFrame)
      cancelAnimationFrame(scrollFrame)
      dispose()
    })
  })

  return (
    <section
      class="pdf-viewer"
      data-component="science-pdf"
      style={{ height: props.height ? `${props.height}px` : undefined }}
    >
      <header class="pdf-viewer-toolbar" data-slot="pdf-header">
        <div class="pdf-viewer-title">
          <strong>PDF</strong>
          <Show when={cfg.url}>
            <span title={cfg.url}>{cfg.url?.split("/").pop()}</span>
          </Show>
        </div>

        <Show when={view.pages}>
          {(count) => (
            <div class="pdf-viewer-page-controls" aria-label="Page navigation">
              <button
                type="button"
                aria-label="Previous page"
                disabled={view.currentPage <= 1}
                onClick={() => goToPage(view.currentPage - 1)}
              >
                <span aria-hidden="true">‹</span>
              </button>
              <span class="pdf-viewer-page-status">
                <span class="pdf-viewer-page-label">Page </span>
                <strong>{view.currentPage}</strong>
                <span> of {count().shown}</span>
              </span>
              <button
                type="button"
                aria-label="Next page"
                disabled={view.currentPage >= count().shown}
                onClick={() => goToPage(view.currentPage + 1)}
              >
                <span aria-hidden="true">›</span>
              </button>
            </div>
          )}
        </Show>

        <div class="pdf-viewer-zoom" aria-label="PDF zoom">
          <button type="button" aria-label="Zoom out" onClick={() => changeZoom(-1)}>
            <span aria-hidden="true">−</span>
          </button>
          <button
            type="button"
            classList={{ "is-active": view.zoom === "fit" }}
            aria-label={view.zoom === "fit" ? "Fit page width selected" : "Fit page width"}
            aria-pressed={view.zoom === "fit"}
            onClick={() => {
              setView("zoom", "fit")
              requestRender()
            }}
          >
            {zoomLabel()}
          </button>
          <button type="button" aria-label="Zoom in" onClick={() => changeZoom(1)}>
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </header>

      <div ref={viewport} class="atlas-scroll pdf-viewer-body" data-slot="pdf-body">
        <Show when={!hasSource}>
          <div class="pdf-viewer-message" data-slot="pdf-empty">
            No PDF source. Provide <code>{`{ url }`}</code>, <code>{`{ bytes }`}</code>, or <code>{`{ base64 }`}</code>.
          </div>
        </Show>
        <Show when={view.status}>
          <div class="pdf-viewer-message" role="status" aria-live="polite">
            {view.status}
          </div>
        </Show>
        <Show when={view.rendering && !view.status}>
          <div class="pdf-viewer-rendering" role="status" aria-live="polite">
            Rendering {view.pages?.rendered ?? 0} of {view.pages?.shown ?? 0}
          </div>
        </Show>
        <Show when={view.error}>
          {(message) => (
            <div class="pdf-viewer-error" data-slot="pdf-error" role="alert">
              <strong>Couldn’t render this PDF</strong>
              <span>{message()}</span>
            </div>
          )}
        </Show>
        <div ref={host} class="pdf-viewer-pages" data-slot="pdf-pages" />
        <Show when={view.pages && view.pages.shown < view.pages.total}>
          <div class="pdf-viewer-cap-note">
            <For each={[view.pages!]}>
              {(count) =>
                `${count.total - count.shown} more page${count.total - count.shown === 1 ? "" : "s"} not rendered`
              }
            </For>
          </div>
        </Show>
      </div>
    </section>
  )
}

export default PdfViewer
