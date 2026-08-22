import type { StoredArtifactVersion } from "@/artifacts/store"

export type ArtifactTransport = (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>

export type StoredArtifactPreview =
  | { kind: "text"; data: string }
  | { kind: "image"; data: string }
  | { kind: "pdf"; data: Uint8Array }

/** A preview is read into browser memory, so keep it deliberately bounded. */
export const STORED_ARTIFACT_PREVIEW_LIMIT = 8 * 1024 * 1024

export function storedArtifactPreviewKind(version: StoredArtifactVersion): StoredArtifactPreview["kind"] | undefined {
  if (version.mimeType.startsWith("image/")) return "image"
  if (version.mimeType === "application/pdf" || version.filename.toLowerCase().endsWith(".pdf")) return "pdf"
  if (
    version.mimeType.startsWith("text/") ||
    version.mimeType.includes("json") ||
    /\.(md|markdown|txt|csv|tsv|json|jsonl|yaml|yml|toml|py|r|jl|tex)$/i.test(version.filename)
  )
    return "text"
}

export async function requestStoredArtifact(
  request: ArtifactTransport,
  artifactID: string,
  versionID: string,
  download = false,
): Promise<Response> {
  const response = await request(`/file/artifact-store/${encodeURIComponent(artifactID)}/raw`, undefined, {
    versionID,
    ...(download ? { download: "true" } : {}),
  })
  if (response.ok) return response
  const detail = (await response.text().catch(() => "")).trim()
  throw new Error(detail || `Artifact bytes unavailable (${response.status})`)
}

export async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("Could not decode image bytes"))
    reader.readAsDataURL(blob)
  })
}

export async function loadStoredArtifactPreview(
  request: ArtifactTransport,
  artifactID: string,
  version: StoredArtifactVersion,
): Promise<StoredArtifactPreview | undefined> {
  const kind = storedArtifactPreviewKind(version)
  if (!kind || version.size > STORED_ARTIFACT_PREVIEW_LIMIT) return
  const response = await requestStoredArtifact(request, artifactID, version.id)
  if (kind === "text") return { kind, data: await response.text() }
  if (kind === "pdf") return { kind, data: new Uint8Array(await response.arrayBuffer()) }
  const blob = await response.blob()
  const typed = blob.type === version.mimeType ? blob : new Blob([blob], { type: version.mimeType })
  return { kind, data: await blobDataUrl(typed) }
}

export function downloadBlob(filename: string, blob: Blob): void {
  const object = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = object
  anchor.download = filename
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => URL.revokeObjectURL(object), 0)
}
