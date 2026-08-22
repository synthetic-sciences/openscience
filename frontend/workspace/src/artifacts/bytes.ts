import type { StoredArtifactVersion } from "@/artifacts/store"

export type ArtifactTransport = (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>

export type StoredArtifactPreview =
  | { kind: "text"; data: string }
  | { kind: "image"; data: string }
  | { kind: "pdf"; data: Uint8Array }

/** A preview is read into browser memory, so keep it deliberately bounded. */
export const STORED_ARTIFACT_PREVIEW_LIMIT = 8 * 1024 * 1024
export const STORED_PDF_PREVIEW_LIMIT = 64 * 1024 * 1024

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
  signal?: AbortSignal,
): Promise<Response> {
  const response = await request(
    `/file/artifact-store/${encodeURIComponent(artifactID)}/raw`,
    signal ? { signal } : undefined,
    {
      versionID,
      ...(download ? { download: "true" } : {}),
    },
  )
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
  signal?: AbortSignal,
): Promise<StoredArtifactPreview | undefined> {
  const kind = storedArtifactPreviewKind(version)
  const limit = kind === "pdf" ? STORED_PDF_PREVIEW_LIMIT : STORED_ARTIFACT_PREVIEW_LIMIT
  if (!kind || version.size > limit) return
  const response = await requestStoredArtifact(request, artifactID, version.id, false, signal)
  const bytes = await boundedBytes(response, limit)
  if (kind === "text") return { kind, data: new TextDecoder().decode(bytes) }
  if (kind === "pdf") return { kind, data: bytes }
  const blob = new Blob([bytes], { type: response.headers.get("content-type") ?? version.mimeType })
  const typed = blob.type === version.mimeType ? blob : new Blob([blob], { type: version.mimeType })
  return { kind, data: await blobDataUrl(typed) }
}

async function boundedBytes(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Artifact preview exceeds the ${limit}-byte browser limit`)
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw new Error(`Artifact preview exceeds the ${limit}-byte browser limit`)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const total = { value: 0 }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total.value += chunk.value.byteLength
      if (total.value > limit) {
        await reader.cancel()
        throw new Error(`Artifact preview exceeds the ${limit}-byte browser limit`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total.value)
  const offset = { value: 0 }
  for (const chunk of chunks) {
    bytes.set(chunk, offset.value)
    offset.value += chunk.byteLength
  }
  return bytes
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
  // WebKit can begin a large download on the next task; keep the object alive
  // briefly so clicking a PDF never races immediate URL revocation.
  globalThis.setTimeout(() => URL.revokeObjectURL(object), 1_000)
}
