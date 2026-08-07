import { createResource, onCleanup, onMount } from "solid-js"
import { normalizeStoredArtifacts, type StoredArtifact } from "@/artifacts/store"

/**
 * The narrowest request shape the artifact store needs. Both `sdk.request`
 * (ProjectRequest) and the Files pane's injected transport satisfy it, so a
 * surface can hand over whichever it already holds.
 */
export type ArtifactsRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface ArtifactsSnapshot {
  active: StoredArtifact[]
  trash: StoredArtifact[]
}

async function listArtifacts(request: ArtifactsRequest, state: "active" | "trash") {
  const response = await request(`/file/artifact-store?state=${state}`)
  if (!response.ok) throw new Error(`Artifact store unavailable (${response.status})`)
  return normalizeStoredArtifacts(await response.json())
}

/**
 * Both halves of the store in one snapshot. A failing half degrades to an
 * empty list rather than rejecting: the trash view must still render when
 * only the active listing is broken, and the reverse.
 */
export function loadStoredArtifacts(request: ArtifactsRequest): Promise<ArtifactsSnapshot> {
  return Promise.all((["active", "trash"] as const).map((state) => listArtifacts(request, state).catch(() => []))).then(
    ([active, trash]) => ({ active, trash }),
  )
}

/** Undo a trash: POST /file/artifact-store/:id/restore (routes/file.ts:491). */
export async function restoreStoredArtifact(request: ArtifactsRequest, id: string) {
  const response = await request(`/file/artifact-store/${encodeURIComponent(id)}/restore`, { method: "POST" })
  if (!response.ok) throw new Error((await response.text()) || `Restore failed (${response.status})`)
  return response.json() as Promise<unknown>
}

/**
 * A live artifact snapshot for any surface that lists saved artifacts.
 *
 * This is a plain factory rather than a component so that importing it is the
 * only thing needed to make it run — an exported component that returns null
 * is preserved source text, not preserved behaviour, and its
 * `openscience:artifacts-changed` listener never registers.
 *
 * `scope` is the resource's refetch key: pass `() => sdk.directory` so the
 * snapshot re-reads when the project root changes. It defaults to a constant
 * for callers with no directory of their own.
 */
export function createArtifactsResource(request: ArtifactsRequest, scope: () => unknown = () => true) {
  const [artifacts, { refetch }] = createResource(scope, () => loadStoredArtifacts(request))
  onMount(() => {
    const refresh = () => void refetch()
    window.addEventListener("openscience:artifacts-changed", refresh)
    onCleanup(() => window.removeEventListener("openscience:artifacts-changed", refresh))
  })
  return [artifacts, { refetch }] as const
}
