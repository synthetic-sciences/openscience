import { extension } from "./artifact-thumb"
import { resolveViewer, viewerUsesText } from "./viewer-registry"

export type RemotePreview = "text" | "image" | "pdf"

/**
 * How large a remote file may be before it is download-only.
 *
 * A Volume file is fetched whole — the route has no range support — so this is
 * the ceiling on what a preview will pull out of the cloud before rendering it.
 * The artifact viewer uses the same 8 MB (StoredArtifactView.tsx).
 */
export const REMOTE_PREVIEW_LIMIT = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  pdf: "application/pdf",
}

/**
 * The content type a previewed file's bytes should carry.
 *
 * The route answers every download as `application/octet-stream`, and a blob:
 * URL serves the Blob's recorded type -- so an <img> given octet-stream shows a
 * broken image and an <iframe> given it downloads the file instead of rendering
 * it. The bytes are re-typed from the extension before the URL is made.
 */
export function remoteMime(filename: string): string | undefined {
  return MIME[extension(filename)]
}

/**
 * What a remote file may be previewed as, or undefined when it may not be.
 *
 * `size` is optional because a listing can omit it; an unknown size is treated
 * as previewable, since the alternative is refusing to preview a 2 KB README.
 */
export function remotePreview(filename: string, size?: number): RemotePreview | undefined {
  if (size !== undefined && size > REMOTE_PREVIEW_LIMIT) return undefined
  if (!extension(filename)) return undefined
  const viewer = resolveViewer({ name: filename })
  if (viewerUsesText(viewer)) return "text"
  if (viewer.kind === "image") return "image"
  if (viewer.kind === "pdf") return "pdf"
  return undefined
}
