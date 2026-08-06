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

interface Preview {
  text: string
  html?: string
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
        const body = await props.read(artifact)
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
