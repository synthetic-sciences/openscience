import { localAssetPath, resolvePath } from "@/utils/markdown-assets"
import { rewriteMarkdownImages } from "@synsci/util/markdown"

export interface Manuscript {
  frontmatter: string
  body: string
  bibliographies: string[]
}

export interface Citation {
  key: string
  title?: string
  author?: string
  year?: string
  venue?: string
}

export interface Insertion {
  text: string
  start: number
  end: number
}

export function parseManuscript(source: string): Manuscript {
  const normalized = source.replaceAll("\r\n", "\n")
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  if (!match) return { frontmatter: "", body: normalized, bibliographies: [] }
  const frontmatter = match[1] ?? ""
  const body = normalized.slice(match[0].length).replace(/^\n/, "")
  return {
    frontmatter,
    body,
    bibliographies: bibliographyPaths(frontmatter),
  }
}

export function parseBibtex(source: string): Citation[] {
  const headers = Array.from(source.matchAll(/@[a-z]+\s*\{\s*([^,\s]+)\s*,/gi))
  return headers.flatMap((header) => {
    const index = header.index ?? 0
    const open = source.indexOf("{", index)
    const close = closingBrace(source, open)
    if (open < 0 || close < 0) return []
    const body = source.slice(index + header[0].length, close)
    const fields = bibFields(body)
    const title = cleanBib(fields.title)
    const author = cleanBib(fields.author)
    const year = cleanBib(fields.year)
    const venue = cleanBib(fields.journal ?? fields.booktitle ?? fields.publisher)
    return [
      {
        key: header[1]!,
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
        ...(year ? { year } : {}),
        ...(venue ? { venue } : {}),
      },
    ]
  })
}

export function relativeArtifactPath(manuscript: string, artifact: string): string {
  const manuscriptDrive = /^([A-Za-z]:)[\\/]/.exec(manuscript)?.[1]?.toLowerCase()
  const artifactDrive = /^([A-Za-z]:)[\\/]/.exec(artifact)?.[1]?.toLowerCase()
  if (manuscriptDrive && artifactDrive && manuscriptDrive !== artifactDrive) {
    throw new Error("A manuscript cannot reference a figure from another drive")
  }
  const from = cleanPath(manuscript).split("/").slice(0, -1)
  const target = cleanPath(artifact).split("/")
  const shared = from.findIndex((part, index) => part !== target[index])
  const common = shared < 0 ? Math.min(from.length, target.length) : shared
  const parents = Array.from({ length: from.length - common }, () => "..")
  const relative = [...parents, ...target.slice(common)].join("/")
  return relative || target.at(-1) || artifact
}

export function resolveReferencePath(manuscript: string, reference: string): string {
  return resolvePath(manuscript, reference)
}

export function rewritePreviewImages(markdown: string, manuscript: string, asset: (path: string) => string): string {
  return rewriteMarkdownImages(markdown, (image) => {
    const path = localAssetPath(image.target, manuscript)
    return path ? asset(path) : undefined
  })
}

export function figureMarkdown(label: string, manuscript: string, artifact: string): string {
  const alt =
    label.trim() ||
    artifact
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ||
    "Figure"
  const target = relativeArtifactPath(manuscript, artifact)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
  return `![${alt.replaceAll("]", "\\]")}](${target})`
}

export function insertSelection(source: string, insertion: string, start: number, end: number): Insertion {
  const lower = Math.max(0, Math.min(start, source.length))
  const upper = Math.max(lower, Math.min(end, source.length))
  const text = `${source.slice(0, lower)}${insertion}${source.slice(upper)}`
  const caret = lower + insertion.length
  return { text, start: caret, end: caret }
}

function bibliographyPaths(frontmatter: string): string[] {
  const lines = frontmatter.split("\n")
  const row = lines.findIndex((line) => /^\s*bibliography\s*:/.test(line))
  if (row < 0) return []
  const value = lines[row]!.replace(/^\s*bibliography\s*:\s*/, "").trim()
  const inline = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).split(",") : value ? [value] : []
  const tail = lines.slice(row + 1)
  const stop = tail.findIndex((line) => !/^\s+-\s+/.test(line))
  const block = value ? [] : tail.slice(0, stop < 0 ? tail.length : stop).map((line) => line.replace(/^\s+-\s+/, ""))
  return Array.from(new Set([...inline, ...block].map(unquote).filter(Boolean)))
}

function bibFields(source: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const headers = Array.from(source.matchAll(/\b([a-z][a-z0-9_-]*)\s*=\s*/gi))
  for (const [index, header] of headers.entries()) {
    const start = (header.index ?? 0) + header[0].length
    const end = headers[index + 1]?.index ?? source.length
    const raw = source.slice(start, end).replace(/,\s*$/, "").trim()
    fields[header[1]!.toLowerCase()] = raw
  }
  return fields
}

function closingBrace(source: string, start: number): number {
  const state = { depth: 0, end: -1, quote: false, escaped: false }
  for (const [offset, char] of Array.from(source.slice(start)).entries()) {
    if (state.end >= 0) continue
    if (char === "\\" && !state.escaped) {
      state.escaped = true
      continue
    }
    if (char === '"' && !state.escaped) state.quote = !state.quote
    if (!state.quote && char === "{") state.depth += 1
    if (!state.quote && char === "}") state.depth -= 1
    if (state.depth === 0) state.end = start + offset
    state.escaped = false
  }
  return state.end
}

function cleanBib(value: string | undefined): string | undefined {
  if (!value) return
  const clean = value
    .trim()
    .replace(/^["{]+|["}]+$/g, "")
    .replaceAll("{", "")
    .replaceAll("}", "")
    .replace(/\s+/g, " ")
    .trim()
  return clean || undefined
}

function cleanPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+/g, "/")
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2")
}
