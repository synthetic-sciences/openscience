import { Match, Show, Switch, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import type { StoredArtifact } from "@/artifacts/store"
import { extension, thumbKind, thumbLanguage } from "./artifact-thumb"

export interface ThumbProps {
  artifact: StoredArtifact
  /** Absolute URL for the artifact's immutable bytes. */
  url: (artifact: StoredArtifact, download?: boolean) => string
  /** Reads those bytes as text. Injected so a standalone mount needs no network. */
  read: (artifact: StoredArtifact) => Promise<string>
  /** Defaults to the shared shiki highlighter; injected in tests. */
  highlight?: (code: string, lang: string) => Promise<string>
}

const PREVIEW_LINES = 10

const shared = (code: string, lang: string) =>
  import("@synsci/ui/context/marked").then((module) => module.highlightSnippet(code, lang))

export function ArtifactThumb(props: ThumbProps): JSX.Element {
  const kind = () => thumbKind(props.artifact.current)
  const [preview, setPreview] = createSignal<{ text: string; html?: string }>()
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
    if (kind() !== "text") return

    let live = true
    onCleanup(() => (live = false))

    void (async () => {
      try {
        // Inside the try, because `read` can throw rather than reject:
        // sdk.request is a plain function that throws when no project is open.
        const body = await props.read(artifact)
        const lines = body.split("\n").slice(0, PREVIEW_LINES).join("\n")
        const html = await (props.highlight ?? shared)(lines, thumbLanguage(artifact.current.filename)).catch(
          () => undefined,
        )
        if (live) setPreview({ text: lines, html })
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
      <Match when={kind() === "image" && !failed()}>
        {/* Bytes that cannot be served must reach the same chip as an unreadable
            text preview, not the browser's broken-image glyph. */}
        <img
          class="artifact-thumb artifact-thumb--image"
          src={props.url(props.artifact)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
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
