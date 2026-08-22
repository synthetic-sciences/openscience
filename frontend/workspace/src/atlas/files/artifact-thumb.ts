import type { StoredArtifactVersion } from "@/artifacts/store"
import { STORED_ARTIFACT_PREVIEW_LIMIT } from "@/artifacts/bytes"

export type ThumbKind = "image" | "text" | "binary"

/** Largest artifact worth reading for a ten-line preview. */
export const PREVIEW_LIMIT = 64 * 1_024

export const extension = (name: string): string => {
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index + 1).toLowerCase() : ""
}

// Extension → shiki grammar id. Lives here rather than in FilePreview so a
// thumbnail and the view it opens into cannot disagree about a file's language.
export const LANG: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rs: "rust",
  go: "go",
  swift: "swift",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cu: "cpp",
  // .tex and friends are text/source files — highlight them as LaTeX source
  // (shiki has a `latex` grammar). A full \documentclass document must never
  // be fed to KaTeX (which only typesets a single math string → blank page).
  tex: "latex",
  latex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "latex",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  r: "r",
  jl: "julia",
  lua: "lua",
  dockerfile: "docker",
  makefile: "makefile",
  csv: "csv",
  txt: "text",
  log: "text",
  md: "markdown",
}

export const thumbLanguage = (filename: string) => LANG[extension(filename)] ?? "text"

// A MIME type that names no format at all. The store assigns it to plain source
// files, so it must not be read as evidence that the bytes are binary.
const generic = (mime: string) => mime === "" || mime.startsWith("application/octet-stream")

const textual = (mime: string) =>
  mime.startsWith("text/") || /(json|xml|yaml|toml|csv|markdown|javascript|typescript|x-sh)/.test(mime)

export function thumbKind(version: StoredArtifactVersion): ThumbKind {
  if (version.mimeType.startsWith("image/")) return version.size <= STORED_ARTIFACT_PREVIEW_LIMIT ? "image" : "binary"
  if (version.size > PREVIEW_LIMIT) return "binary"
  if (generic(version.mimeType)) return LANG[extension(version.filename)] ? "text" : "binary"
  return textual(version.mimeType) ? "text" : "binary"
}
