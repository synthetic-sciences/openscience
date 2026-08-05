import { Match, Show, Switch, createResource, type JSX } from "solid-js"
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

  // A failed preview is a quiet chip, never a thrown error: this renders inside
  // the workspace's only ErrorBoundary, and one unreadable artifact must not
  // replace the whole pane.
  const [preview] = createResource(
    () => (kind() === "text" ? props.artifact : undefined),
    // One shape, always: a union would force every reader to narrow, and the
    // interesting case here is "we have nothing", not "which variant".
    async (artifact): Promise<{ text: string; html: string | undefined; failed: boolean }> => {
      const body = await props.read(artifact).catch(() => undefined)
      if (body === undefined) return { text: "", html: undefined, failed: true }
      const lines = body.split("\n").slice(0, PREVIEW_LINES).join("\n")
      const tinted = await (props.highlight ?? shared)(lines, thumbLanguage(artifact.current.filename)).catch(
        () => undefined,
      )
      return { text: lines, html: tinted, failed: false }
    },
  )

  const chip = () => (
    <span class="artifact-thumb artifact-thumb--binary">
      <span data-thumb-chip>{extension(props.artifact.current.filename) || "file"}</span>
    </span>
  )

  return (
    <Switch fallback={chip()}>
      <Match when={kind() === "image"}>
        <img class="artifact-thumb artifact-thumb--image" src={props.url(props.artifact)} alt="" loading="lazy" />
      </Match>
      <Match when={kind() === "text" && preview.latest}>
        {(value) => (
          <Show when={!value().failed} fallback={chip()}>
            {/* innerHTML and children cannot both own a node, so the tinted and
                plain cases are separate elements rather than one with a Show
                nested inside it. */}
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
          </Show>
        )}
      </Match>
    </Switch>
  )
}
