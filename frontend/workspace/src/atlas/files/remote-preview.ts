import { extension } from "./artifact-thumb"

export type RemotePreview = "text" | "image" | "pdf"

/**
 * How large a remote file may be before it is download-only.
 *
 * A Volume file is fetched whole — the route has no range support — so this is
 * the ceiling on what a preview will pull out of the cloud before rendering it.
 * The artifact viewer uses the same 8 MB (StoredArtifactView.tsx).
 */
export const REMOTE_PREVIEW_LIMIT = 8 * 1024 * 1024

// An allowlist, not a heuristic. Anything absent downloads, which is both the
// safe default for a format we cannot render and the honest one for a 40 GB
// checkpoint that no viewer should try to open.
const TEXT = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "log",
  "json",
  "jsonl",
  "ndjson",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "html",
  "css",
  "py",
  "r",
  "jl",
  "sh",
  "bash",
  "zsh",
  "sql",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "go",
  "rs",
  "c",
  "h",
  "cpp",
  "hpp",
  "java",
  "kt",
  "rb",
  "swift",
  "tex",
  "ipynb",
])

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"])

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
  const ext = extension(filename)
  if (TEXT.has(ext)) return "text"
  if (IMAGE.has(ext)) return "image"
  if (ext === "pdf") return "pdf"
  return undefined
}
