import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import type { ArtifactRenderProps } from "../registry"

/**
 * `pdf` renderer — rasterizes PDF pages to <canvas> with pdfjs-dist.
 *
 * pdfjs-dist is a framework-agnostic vanilla-JS library (no React). We load the
 * document in `onMount` via `getDocument(...)` and render each page onto its own
 * canvas in a vertical scroll container. The worker and the whole library are
 * pulled with a dynamic `import()` so they are code-split out of the main bundle
 * and only fetched when a PDF artifact is first shown.
 *
 * On unmount we cancel any in-flight render tasks and `destroy()` the document —
 * pdfjs holds a Web Worker + detached canvases, so disposal matters.
 *
 * Expected `props.data` — several shapes are accepted and normalized:
 * ```
 * { url: string }                         // fetched by pdfjs (CORS applies)
 * { bytes: ArrayBuffer | Uint8Array }     // in-memory document
 * { data:  ArrayBuffer | Uint8Array }     // alias for bytes
 * { base64: string }                      // base64 (optionally a data: URI)
 * "https://…/paper.pdf"                    // bare url string
 * "data:application/pdf;base64,…"          // bare data URI
 * ```
 * Optional: `scale` (default 1.35), `maxPages` (default 12 — caps how many pages
 * are rasterized so a 400-page PDF doesn't lock the tab).
 */

interface PdfData {
  url?: string
  bytes?: ArrayBuffer | Uint8Array
  base64?: string
  scale: number
  maxPages: number
}

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

// pdfjs-dist has no bundled TS types on this path; keep the surface we use tight.
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
  destroy(): Promise<void>
}
interface PdfLib {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDoc> }
  GlobalWorkerOptions: { workerSrc: string }
}

export function PdfViewer(props: ArtifactRenderProps) {
  let host!: HTMLDivElement
  const cfg = normalize(props.data)
  const hasSource = Boolean(cfg.url || cfg.bytes || cfg.base64)
  const [error, setError] = createSignal<string>()
  const [status, setStatus] = createSignal<string>(hasSource ? "Loading PDF…" : "")
  const [pages, setPages] = createSignal<{ total: number; shown: number }>()

  onMount(() => {
    let doc: PdfDoc | undefined
    let disposed = false
    const tasks: Array<{ cancel(): void }> = []

    if (!hasSource) return
    ;(async () => {
      try {
        const pdfjs = (await import("pdfjs-dist")) as unknown as PdfLib
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default
          pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        }

        const src: Record<string, unknown> = cfg.url
          ? { url: cfg.url }
          : { data: cfg.bytes ?? decodeBase64(cfg.base64 ?? "") }
        const loaded = await pdfjs.getDocument(src).promise
        if (disposed) {
          await loaded.destroy()
          return
        }
        doc = loaded

        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
        const total = doc.numPages
        const shown = Math.min(total, cfg.maxPages)
        setPages({ total, shown })
        setStatus("")

        for (let n = 1; n <= shown; n++) {
          if (disposed) break
          const page = await doc.getPage(n)
          if (disposed) break
          const viewport = page.getViewport({ scale: cfg.scale })
          const canvas = document.createElement("canvas")
          canvas.width = Math.floor(viewport.width * dpr)
          canvas.height = Math.floor(viewport.height * dpr)
          canvas.style.width = `${Math.floor(viewport.width)}px`
          canvas.style.height = `${Math.floor(viewport.height)}px`
          canvas.style.display = "block"
          canvas.style.margin = "0 auto 12px"
          canvas.style.maxWidth = "100%"
          canvas.style.boxShadow = "0 1px 4px rgba(0,0,0,0.18)"
          canvas.style.borderRadius = "4px"
          const ctx = canvas.getContext("2d")
          if (!ctx) continue
          if (dpr !== 1) ctx.scale(dpr, dpr)
          host.appendChild(canvas)
          const task = page.render({ canvasContext: ctx, viewport })
          tasks.push(task)
          try {
            await task.promise
          } catch {
            /* render cancelled on unmount — ignore */
          }
        }
      } catch (e) {
        if (!disposed) {
          setStatus("")
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    })()

    onCleanup(() => {
      disposed = true
      for (const t of tasks) {
        try {
          t.cancel()
        } catch {
          /* ignore */
        }
      }
      doc?.destroy().catch(() => {
        /* ignore teardown races */
      })
    })
  })

  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"

  return (
    <div
      data-component="science-pdf"
      style={{
        display: "flex",
        "flex-direction": "column",
        border: "1px solid rgba(128,128,128,0.28)",
        "border-radius": "4px",
        overflow: "hidden",
        background: "rgba(128,128,128,0.05)",
      }}
    >
      <div
        data-slot="pdf-header"
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          padding: "5px 10px",
          "font-size": "11px",
          "font-family": mono,
          color: "#8a8a8a",
          background: "rgba(128,128,128,0.08)",
          "border-bottom": "1px solid rgba(128,128,128,0.2)",
        }}
      >
        <span>PDF{cfg.url ? ` · ${cfg.url.split("/").pop()}` : ""}</span>
        <Show when={pages()}>
          {(p) => (
            <span>
              {p().shown < p().total
                ? `${p().shown} of ${p().total} pages`
                : `${p().total} page${p().total === 1 ? "" : "s"}`}
            </span>
          )}
        </Show>
      </div>
      <div
        data-slot="pdf-body"
        style={{
          "max-height": `${props.height ?? 560}px`,
          overflow: "auto",
          padding: "12px",
          "text-align": "center",
        }}
      >
        <Show when={!hasSource}>
          <div
            data-slot="pdf-empty"
            style={{ padding: "28px 14px", "font-family": mono, "font-size": "12px", color: "#8a8a8a" }}
          >
            No PDF source. Provide <code>{`{ url }`}</code>, <code>{`{ bytes }`}</code>, or <code>{`{ base64 }`}</code>.
          </div>
        </Show>
        <Show when={status()}>
          <div style={{ padding: "28px 14px", "font-family": mono, "font-size": "12px", color: "#8a8a8a" }}>
            {status()}
          </div>
        </Show>
        <Show when={error()}>
          {(msg) => (
            <div
              data-slot="pdf-error"
              style={{
                padding: "12px 14px",
                "font-family": mono,
                "font-size": "12px",
                color: "#b00020",
                border: "1px solid rgba(176,0,32,0.35)",
                "border-radius": "4px",
                background: "rgba(176,0,32,0.06)",
                "text-align": "left",
              }}
            >
              Failed to render PDF: {msg()}
            </div>
          )}
        </Show>
        <div ref={host} data-slot="pdf-pages" />
        <Show when={pages() && pages()!.shown < pages()!.total}>
          <div style={{ "font-family": mono, "font-size": "11px", color: "#8a8a8a", "padding-top": "4px" }}>
            {/* rendering is capped by maxPages */}
            <For each={[pages()!]}>{(p) => <>{p.total - p.shown} more page(s) not rendered</>}</For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default PdfViewer
