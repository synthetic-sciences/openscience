import { Show, createMemo, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { get, type ArtifactKind } from "./renderers"

/**
 * Dispatcher for scientific artifacts rendered inline in chat.
 *
 * Given `{ kind, data }`, looks up the registered renderer for `kind` and mounts
 * it. If no renderer is registered (or it throws at mount), falls back to a
 * graceful placeholder + a collapsed JSON dump so the artifact is never lost.
 *
 * Integration: a tool renderer registered via `@synsci/ui/message-part`'s
 * `ToolRegistry.register(...)` reads the science-artifact envelope from a tool
 * part's `metadata` and mounts this component. See SCIENCE_PATTERNS.md.
 */

export interface ScienceArtifactProps {
  kind: ArtifactKind
  data: unknown
  height?: number
}

export function ScienceArtifact(props: ScienceArtifactProps): JSX.Element {
  const renderer = createMemo(() => get(props.kind))

  return (
    <div data-component="science-artifact" data-kind={props.kind}>
      <Show when={renderer()} fallback={<ScienceArtifactFallback kind={props.kind} data={props.data} />}>
        {(Renderer) => <Dynamic component={Renderer()} kind={props.kind} data={props.data} height={props.height} />}
      </Show>
    </div>
  )
}

function ScienceArtifactFallback(props: { kind: ArtifactKind; data: unknown }): JSX.Element {
  const preview = createMemo(() => {
    try {
      return JSON.stringify(props.data, null, 2).slice(0, 2000)
    } catch {
      return String(props.data)
    }
  })
  return (
    <div data-component="science-artifact-fallback">
      <div data-slot="science-artifact-fallback-title">No renderer registered for artifact kind “{props.kind}”.</div>
      <details data-slot="science-artifact-fallback-details">
        <summary>Raw artifact data</summary>
        <pre>{preview()}</pre>
      </details>
    </div>
  )
}

export default ScienceArtifact
