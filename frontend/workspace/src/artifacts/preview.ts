import { createResource, onCleanup, type Accessor } from "solid-js"
import { fileReadRetryDelay, isFileRequestCancellation } from "@/atlas/file-viewer"
import { loadStoredArtifactPreview, type ArtifactTransport } from "./bytes"
import type { StoredArtifactVersion } from "./store"

export interface ArtifactPreviewSource {
  scope: string
  artifactID: string
  version?: StoredArtifactVersion
}

/** The resource that starts a read also owns its cancellation. A separate
 * mount effect can otherwise abort the request it was meant to protect. */
export function createStoredArtifactPreview(request: ArtifactTransport, source: Accessor<ArtifactPreviewSource>) {
  let controller: AbortController | undefined
  const [preview, actions] = createResource(source, async ({ scope, artifactID, version }) => {
    controller?.abort(new DOMException("Artifact preview changed", "AbortError"))
    controller = undefined
    // An unavailable version is still a source change: cancel the previous
    // file immediately while the next artifact's metadata is being loaded.
    if (!version) return
    const current = new AbortController()
    controller = current
    for (let attempt = 0; !current.signal.aborted; attempt += 1) {
      try {
        const data = await loadStoredArtifactPreview(request, artifactID, version, current.signal)
        if (current.signal.aborted) return
        return { scope, artifactID, versionID: version.id, data }
      } catch (error) {
        if (current.signal.aborted) return
        const delay = isFileRequestCancellation(error) ? fileReadRetryDelay(attempt) : undefined
        if (delay === undefined) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }
  })
  onCleanup(() => controller?.abort(new DOMException("Artifact preview closed", "AbortError")))
  return [preview, actions] as const
}
