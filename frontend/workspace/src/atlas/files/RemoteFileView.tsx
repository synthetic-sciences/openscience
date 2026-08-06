import { Match, Show, Switch, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { IconDownload, IconX } from "@/atlas/shared/Icon"
import { bytes } from "./bytes"
import { thumbLanguage } from "./artifact-thumb"
import { remoteMime, remotePreview, type RemotePreview } from "./remote-preview"

export interface RemoteFile {
  name: string
  /** Path inside the Volume, as the listing reported it. */
  path: string
  volume: string
  size?: number
}

export interface RemoteFileViewProps {
  file: RemoteFile
  /** Fetches the file's bytes. Injected so a standalone mount needs no network. */
  read: (file: RemoteFile) => Promise<Blob>
  onDownload: (file: RemoteFile) => void
  onClose: () => void
  /** Defaults to the shared shiki highlighter; injected in tests. */
  highlight?: (code: string, lang: string) => Promise<string>
}

const shared = (code: string, lang: string) =>
  import("@synsci/ui/context/marked").then((module) => module.highlightSnippet(code, lang))

interface Cached {
  bytes: number
  text?: { body: string; html?: string }
  /** Images keep their data: URL, which needs no revoking and can be reused. */
  dataUrl?: string
  /** PDFs keep the typed bytes; the object URL is remade per mount and revoked. */
  blob?: Blob
}

/**
 * Files already fetched out of a Volume.
 *
 * Switching tabs unmounts this viewer, so without it every switch went back to
 * Modal -- seconds each time for bytes already in hand. Keyed by volume, path
 * and size: a Volume file can change, unlike an artifact version, and the size
 * is the cheapest signal of that a listing gives us. A file edited in place to
 * exactly the same length serves the previous bytes until the pane reloads.
 */
const fetched = new Map<string, Cached>()
const CACHE_BUDGET = 32 * 1024 * 1024

const cacheKey = (file: RemoteFile) => `${file.volume}\u0000${file.path}\u0000${file.size ?? "?"}`

const keep = (key: string, entry: Cached) => {
  let held = entry.bytes
  for (const value of fetched.values()) held += value.bytes
  // Oldest out first; a preview is worth re-fetching, a wedged tab is not.
  for (const [oldest, value] of fetched) {
    if (held <= CACHE_BUDGET) break
    fetched.delete(oldest)
    held -= value.bytes
  }
  fetched.set(key, entry)
}

export function RemoteFileView(props: RemoteFileViewProps): JSX.Element {
  const [text, setText] = createSignal<{ body: string; html?: string }>()
  const [url, setUrl] = createSignal<string>()
  const [failed, setFailed] = createSignal("")

  const kind = (): RemotePreview | undefined => remotePreview(props.file.name, props.file.size)

  // A signal fed by an effect, never a resource: reading a resource from the
  // render tree suspends the nearest <Suspense>, and this pane renders inside
  // RightPane's.
  createEffect(() => {
    const file = props.file
    const shape = kind()
    setText(undefined)
    setUrl(undefined)
    setFailed("")
    if (!shape) return

    let live = true
    let revoke: string | undefined
    onCleanup(() => {
      live = false
      // The blob is this component's to release; leaving it costs the tab's
      // bytes for the lifetime of the document.
      if (revoke) URL.revokeObjectURL(revoke)
    })

    const key = cacheKey(file)
    const hit = fetched.get(key)
    if (hit) {
      if (hit.text) setText(hit.text)
      if (hit.dataUrl) setUrl(hit.dataUrl)
      if (hit.blob) {
        revoke = URL.createObjectURL(hit.blob)
        setUrl(revoke)
      }
      return
    }

    void (async () => {
      try {
        const blob = await props.read(file)
        if (!live) return
        if (shape === "text") {
          const body = await blob.text()
          const html = await (props.highlight ?? shared)(body, thumbLanguage(file.name)).catch(() => undefined)
          keep(key, { bytes: blob.size, text: { body, html } })
          if (live) setText({ body, html })
          return
        }
        // The app's CSP is img-src 'self' data: https: and frame-src 'self' blob:
        // (server.ts), so the two shapes need different carriers:
        //
        // An image cannot come from a blob: URL at all -- verified in the app,
        // where a valid PNG decodes as data: and fails as blob: -- so its bytes
        // become a data: URL.
        //
        // A PDF may use blob:, but only once it is re-typed: these bytes arrive
        // as application/octet-stream, and an <iframe> handed that downloads the
        // file instead of displaying it.
        const mime = remoteMime(file.name)
        const typed = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob
        if (shape === "image") {
          const encoded = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error ?? new Error("could not decode the image"))
            reader.readAsDataURL(typed)
          })
          keep(key, { bytes: typed.size, dataUrl: encoded })
          if (live) setUrl(encoded)
          return
        }
        keep(key, { bytes: typed.size, blob: typed })
        revoke = URL.createObjectURL(typed)
        if (live) setUrl(revoke)
      } catch (error) {
        if (live) setFailed(error instanceof Error ? error.message : String(error))
      }
    })()
  })

  return (
    <section class="remote-view" aria-label={`${props.file.name} in ${props.file.volume}`}>
      <header class="remote-view__bar">
        <span class="remote-view__title">
          <span class="remote-view__name">{props.file.name}</span>
          <span class="remote-view__sub">
            {props.file.volume}
            <Show when={props.file.size !== undefined}> · {bytes(props.file.size)}</Show>
          </span>
        </span>
        <button
          type="button"
          class="remote-view__action"
          data-remote-download
          onClick={() => props.onDownload(props.file)}
        >
          <IconDownload size={13} strokeWidth={1.6} />
          Download
        </button>
        <button
          type="button"
          class="remote-view__action remote-view__action--icon"
          aria-label={`Close ${props.file.name}`}
          onClick={() => props.onClose()}
        >
          <IconX size={13} strokeWidth={1.6} />
        </button>
      </header>

      <div class="remote-view__body atlas-scroll">
        <Switch
          fallback={
            // Not an error: a format this viewer will not guess at, or a file
            // too large to pull whole out of the cloud for a look.
            <div class="remote-view__empty" data-remote-unsupported>
              <p>This file is not previewed here.</p>
              <p class="remote-view__hint">Download it to open it with something that understands the format.</p>
            </div>
          }
        >
          <Match when={failed()}>
            <div class="remote-view__empty" role="status" data-remote-error>
              <p>{props.file.name} could not be read.</p>
              <p class="remote-view__hint">{failed()}</p>
            </div>
          </Match>
          <Match when={kind() === "text" && text()}>
            {(value) => (
              <Show
                when={value().html}
                fallback={
                  <pre class="remote-view__text" data-remote-text>
                    {value().body}
                  </pre>
                }
              >
                {(html) => <pre class="remote-view__text" data-remote-text innerHTML={html()} />}
              </Show>
            )}
          </Match>
          <Match when={kind() === "image" && url()}>
            {(source) => <img class="remote-view__image" data-remote-image src={source()} alt={props.file.name} />}
          </Match>
          <Match when={kind() === "pdf" && url()}>
            {(source) => <iframe class="remote-view__frame" data-remote-pdf title={props.file.name} src={source()} />}
          </Match>
          <Match when={kind() && !text() && !url()}>
            <div class="remote-view__empty" data-remote-loading>
              <p>Fetching {props.file.name}…</p>
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  )
}
