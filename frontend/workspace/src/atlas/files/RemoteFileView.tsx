import { Match, Show, Switch, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { IconDownload, IconX } from "@/atlas/shared/Icon"
import { bytes } from "./bytes"
import { thumbLanguage } from "./artifact-thumb"
import { remotePreview, type RemotePreview } from "./remote-preview"

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

    void (async () => {
      try {
        const blob = await props.read(file)
        if (!live) return
        if (shape === "text") {
          const body = await blob.text()
          const html = await (props.highlight ?? shared)(body, thumbLanguage(file.name)).catch(() => undefined)
          if (live) setText({ body, html })
          return
        }
        // Fetched to a blob rather than pointed at the route: the endpoint
        // answers with Content-Disposition: attachment, which a browser may
        // honour by downloading instead of rendering.
        revoke = URL.createObjectURL(blob)
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
