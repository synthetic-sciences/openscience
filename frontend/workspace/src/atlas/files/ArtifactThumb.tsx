import { Match, Show, Switch, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { blobDataUrl } from "@/artifacts/bytes"
import type { StoredArtifact } from "@/artifacts/store"
import { ensurePdfWorker } from "@/science/renderers/documents/pdfjs-worker"
import { extension, thumbKind, thumbLanguage } from "./artifact-thumb"

export interface ThumbProps {
  artifact: StoredArtifact
  /** Reads immutable bytes through the authenticated transport. */
  read: (artifact: StoredArtifact) => Promise<Blob>
  /** Defaults to the shared shiki highlighter; injected in tests. */
  highlight?: (code: string, lang: string) => Promise<string>
}

const PREVIEW_LINES = 10

const shared = (code: string, lang: string) =>
  import("@synsci/ui/context/marked").then((module) => module.highlightSnippet(code, lang))

interface Preview {
  text?: string
  html?: string
  image?: string
  table?: string[][]
  label?: string
}

const cells = (body: string, filename: string) => {
  const delimiter = extension(filename) === "tsv" ? "\t" : ","
  return body
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 5)
    .map((row) =>
      row
        .split(delimiter)
        .slice(0, 4)
        .map((cell) => cell.trim().replace(/^['"]|['"]$/g, "")),
    )
}

const notebookText = (body: string) => {
  const value = JSON.parse(body) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> }
  const cell = value.cells?.find((item) => item.cell_type === "markdown" || item.cell_type === "code")
  const source = Array.isArray(cell?.source) ? cell.source.join("") : (cell?.source ?? "")
  return { text: source.split("\n").slice(0, PREVIEW_LINES).join("\n"), label: cell?.cell_type ?? "notebook" }
}

const pdfImage = async (blob: Blob) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  ensurePdfWorker(pdfjs.GlobalWorkerOptions)
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) })
  const pdf = await task.promise
  try {
    const page = await pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(1.4, 320 / Math.max(1, base.width)) })
    const canvas = document.createElement("canvas")
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas unavailable")
    await page.render({ canvas, canvasContext: context, viewport }).promise
    return canvas.toDataURL("image/png")
  } finally {
    await task.destroy()
  }
}

/**
 * Rendered previews, keyed by artifact VERSION id.
 *
 * A version's bytes are immutable — that is the whole point of the store — so a
 * preview only ever has to be produced once. Without this, anything that
 * rebuilds the card list re-reads every artifact and re-runs the highlighter:
 * changing the sort regroups, which makes <For> recreate every card, and so does
 * leaving the artifacts source and coming back.
 *
 * Failures are deliberately not cached, so a read that failed while the server
 * was down succeeds on the next look.
 */
const previews = new Map<string, Preview>()
const PREVIEW_CACHE_LIMIT = 200

const remember = (version: string, preview: Preview) => {
  // Only evict when the map is about to grow: overwriting a key it already holds
  // would otherwise drop an unrelated entry for nothing.
  if (!previews.has(version) && previews.size >= PREVIEW_CACHE_LIMIT) {
    const oldest = previews.keys().next()
    if (!oldest.done) previews.delete(oldest.value)
  }
  previews.set(version, preview)
}

export function ArtifactThumb(props: ThumbProps): JSX.Element {
  const kind = () => thumbKind(props.artifact.current)
  const [preview, setPreview] = createSignal<Preview>()
  const [failed, setFailed] = createSignal(false)

  // Deliberately a signal and an effect rather than createResource. Reading a
  // resource from the render tree increments the nearest <Suspense> counter, and
  // this renders inside RightPane's (RightPane.tsx:351) -- one thumbnail waiting
  // on shiki's cold start replaced the whole pane with the spinner, the same
  // hazard FilesPane.tsx:248 already documents for the listing.
  createEffect(() => {
    const artifact = props.artifact
    setPreview(undefined)
    setFailed(false)
    if (kind() === "binary") return

    const cached = previews.get(artifact.current.id)
    if (cached) {
      setPreview(cached)
      return
    }

    let live = true
    onCleanup(() => (live = false))

    void (async () => {
      try {
        // Inside the try, because `read` can throw rather than reject:
        // sdk.request is a plain function that throws when no project is open.
        const blob = await props.read(artifact)
        if (kind() === "image") {
          const typed =
            blob.type === artifact.current.mimeType ? blob : new Blob([blob], { type: artifact.current.mimeType })
          const preview = { image: await blobDataUrl(typed) }
          remember(artifact.current.id, preview)
          if (live) setPreview(preview)
          return
        }
        if (kind() === "pdf") {
          const preview = { image: await pdfImage(blob), label: "PDF preview" }
          remember(artifact.current.id, preview)
          if (live) setPreview(preview)
          return
        }
        const body = await blob.text()
        if (kind() === "table") {
          const preview = { table: cells(body, artifact.current.filename) }
          remember(artifact.current.id, preview)
          if (live) setPreview(preview)
          return
        }
        if (kind() === "notebook") {
          const preview = notebookText(body)
          remember(artifact.current.id, preview)
          if (live) setPreview(preview)
          return
        }
        const lines = body.split("\n").slice(0, PREVIEW_LINES).join("\n")
        const html = await (props.highlight ?? shared)(lines, thumbLanguage(artifact.current.filename)).catch(
          () => undefined,
        )
        const preview = { text: lines, html }
        remember(artifact.current.id, preview)
        if (live) setPreview(preview)
      } catch {
        if (live) setFailed(true)
      }
    })()
  })

  const chip = () => (
    <span class="artifact-thumb artifact-thumb--binary">
      <span data-thumb-chip>{extension(props.artifact.current.filename) || "file"}</span>
    </span>
  )

  return (
    <Switch fallback={chip()}>
      <Match when={kind() === "image" && !failed() && preview()?.image}>
        {(image) => <img class="artifact-thumb artifact-thumb--image" src={image()} alt="" />}
      </Match>
      <Match when={kind() === "pdf" && !failed() && preview()?.image}>
        {(image) => (
          <img class="artifact-thumb artifact-thumb--image artifact-thumb--pdf" src={image()} alt="PDF first page" />
        )}
      </Match>
      <Match when={kind() === "table" && !failed() && preview()?.table}>
        {(rows) => (
          <span class="artifact-thumb artifact-thumb--table" aria-label="Table preview">
            {rows().map((row) => row.map((cell) => <span title={cell}>{cell}</span>))}
          </span>
        )}
      </Match>
      <Match when={kind() === "notebook" && !failed() && preview()}>
        {(value) => (
          <span class="artifact-thumb artifact-thumb--notebook">
            <small>{value().label}</small>
            <pre>{value().text}</pre>
          </span>
        )}
      </Match>
      <Match when={kind() === "text" && !failed() && preview()}>
        {(value) => (
          // innerHTML and children cannot both own a node, so the tinted and
          // plain cases are separate elements rather than one nested inside the
          // other.
          <Show
            when={value().html}
            fallback={
              <pre class="artifact-thumb artifact-thumb--text" data-thumb-text>
                {value().text}
              </pre>
            }
          >
            {(html) => <pre class="artifact-thumb artifact-thumb--text" data-thumb-text innerHTML={html()} />}
          </Show>
        )}
      </Match>
    </Switch>
  )
}
