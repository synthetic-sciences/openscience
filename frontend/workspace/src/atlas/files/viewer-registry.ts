import type { TableFormat } from "@/data/table"
import { LANG, extension } from "./artifact-thumb"

export type ViewerKind = "markdown" | "html" | "table" | "notebook" | "image" | "pdf" | "code" | "text" | "binary"

export type ViewerResolution = {
  kind: ViewerKind
  extension: string
  language: string
  table?: TableFormat
}

const images = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"])
const markdown = new Set(["md", "markdown", "mdx"])
const text = new Set(["txt", "log", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml"])

const generic = (mime: string) => !mime || mime.startsWith("application/octet-stream")
const textual = (mime: string) =>
  mime.startsWith("text/") || /(json|xml|yaml|toml|csv|markdown|javascript|typescript|x-sh)/.test(mime)

export function resolveViewer(input: {
  name: string
  mimeType?: string
  encoding?: "base64" | "utf8" | string
  content?: string
}): ViewerResolution {
  const ext = extension(input.name)
  const mime = input.mimeType?.toLowerCase() ?? ""
  const language = LANG[ext] ?? "text"
  const binary = input.encoding === "base64"

  if (mime.startsWith("image/") || images.has(ext)) return { kind: "image", extension: ext, language }
  if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf", extension: ext, language }
  if (binary) return { kind: "binary", extension: ext, language }
  if (markdown.has(ext) || mime.includes("markdown")) return { kind: "markdown", extension: ext, language: "markdown" }
  if (ext === "html" || ext === "htm") return { kind: "html", extension: ext, language: "html" }
  if (ext === "ipynb") return { kind: "notebook", extension: ext, language: "json" }
  if (ext === "csv" || ext === "tsv" || ext === "jsonl" || ext === "ndjson") {
    return {
      kind: "table",
      extension: ext,
      language,
      table: ext === "ndjson" ? "jsonl" : (ext as TableFormat),
    }
  }
  if (ext === "json" && input.content?.trimStart().startsWith("[")) {
    return { kind: "table", extension: ext, language, table: "json" }
  }
  if (LANG[ext]) return { kind: "code", extension: ext, language }
  if (text.has(ext) || textual(mime)) return { kind: "text", extension: ext, language }
  if (generic(mime) && !ext) return { kind: "text", extension: ext, language }
  return { kind: "binary", extension: ext, language }
}

export function viewerUsesText(viewer: ViewerResolution) {
  return !["image", "pdf", "binary"].includes(viewer.kind)
}
