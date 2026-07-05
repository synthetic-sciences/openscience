/**
 * Image artifact renderer.
 *
 * Handles the `kind: "image"` envelope emitted by the persistent Python/R
 * kernels (`notebook` / `rkernel`), whose payload is `{ images: string[] }` of
 * base64 data URLs (matplotlib figures, etc.). Also tolerates a single-image
 * `{ src }` / `{ url }` / `{ data }` shape.
 */
import { For, Show, createMemo, type JSX } from "solid-js"
import type { ArtifactRenderProps } from "../registry"

function toSources(data: unknown): string[] {
  if (!data) return []
  if (typeof data === "string") return [data]
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.images)) return obj.images.filter((x): x is string => typeof x === "string")
  const single = obj.src ?? obj.url ?? obj.data
  if (typeof single === "string") return [single]
  return []
}

export function ImageView(props: ArtifactRenderProps): JSX.Element {
  const sources = createMemo(() => toSources(props.data))
  return (
    <Show when={sources().length > 0} fallback={<div data-slot="image-artifact-empty">No image data.</div>}>
      <div data-component="image-artifact" style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
        <For each={sources()}>
          {(src) => (
            <img
              src={src}
              alt="artifact"
              style={{
                "max-width": "100%",
                height: props.height ? `${props.height}px` : "auto",
                "border-radius": "4px",
              }}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

export default ImageView
