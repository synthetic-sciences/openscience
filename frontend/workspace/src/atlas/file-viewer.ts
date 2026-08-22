export type FileKind =
  | "markdown"
  | "html"
  | "table"
  | "scientific-data"
  | "scientific-binary"
  | "pdf"
  | "image"
  | "science"
  | "code"
  | "binary"

export interface FileData {
  content?: string
  encoding?: string
  mimeType?: string
  size?: number
  truncated?: boolean
}

export interface FileDescription {
  label: string
  source: boolean
  copy: boolean
  download: boolean
}

const sources = new Set<FileKind>(["markdown", "html", "table", "scientific-data", "science", "code"])

/** Raw PDF previews remain bounded even though the download endpoint itself supports larger files. */
export const PDF_PREVIEW_LIMIT = 64 * 1024 * 1024

export function pdfPreviewMode(input: { truncated: boolean; size?: number }): "inline" | "raw" | "download" {
  if (!input.truncated) return "inline"
  if (input.size !== undefined && input.size <= PDF_PREVIEW_LIMIT) return "raw"
  return "download"
}

function format(value?: string) {
  return value?.trim().replace(/^\./, "").toLowerCase() ?? ""
}

function label(kind: FileKind, value?: string) {
  const type = format(value)
  if (kind === "markdown") return "Markdown"
  if (kind === "html") return "HTML document"
  if (kind === "pdf") return "PDF document"
  if (kind === "image") return type ? `${type.toUpperCase()} image` : "Image"
  if (kind === "table") {
    if (type === "jsonl") return "JSON Lines data"
    return type ? `${type.toUpperCase()} data` : "Tabular data"
  }
  if (kind === "scientific-data") return type ? `${type.toUpperCase()} data` : "Scientific data"
  if (kind === "scientific-binary") return type ? `${type.toUpperCase()} dataset` : "Scientific dataset"
  if (kind === "science") return type ? `${type.toUpperCase()} scientific file` : "Scientific file"
  if (kind === "binary") return "Binary file"
  if (type === "py") return "Python source"
  if (type === "r") return "R source"
  if (type === "tex" || type === "latex") return "LaTeX source"
  if (type === "mdx") return "MDX source"
  if (type === "txt" || !type) return "Text file"
  return `${type.toUpperCase()} source`
}

export function describeFile(input: {
  kind: FileKind
  format?: string
  binary?: boolean
  truncated?: boolean
}): FileDescription {
  return {
    label: label(input.kind, input.format),
    source: !input.binary && !input.truncated && sources.has(input.kind),
    copy: !input.binary && !input.truncated,
    download: true,
  }
}

export function sourceViews(source: boolean): Array<{ id: "preview" | "source"; label: string; active: boolean }> {
  return [
    { id: "preview", label: "Preview", active: !source },
    { id: "source", label: "Source", active: source },
  ]
}

export function toolbarControls(input: {
  description: FileDescription
  source: boolean
  dirty: boolean
  saving: boolean
}): Array<{
  id: "preview" | "source" | "discard" | "save" | "copy" | "download"
  label: string
  active?: boolean
  disabled: boolean
}> {
  const views = input.description.source ? sourceViews(input.source).map((view) => ({ ...view, disabled: false })) : []
  // "Save file" (not "Save") — the toolbar also offers "Save as artifact",
  // and a bare "Save" would be ambiguous between the plain file write and
  // the versioned artifact registration.
  const changes = input.dirty
    ? [
        { id: "discard" as const, label: "Discard", disabled: input.saving },
        { id: "save" as const, label: input.saving ? "Saving…" : "Save file", disabled: input.saving },
      ]
    : []
  const copy = input.description.copy ? [{ id: "copy" as const, label: "Copy", disabled: false }] : []
  const download = input.description.download ? [{ id: "download" as const, label: "Download", disabled: false }] : []
  return [...views, ...changes, ...copy, ...download]
}

/**
 * "Save as artifact" turns the previewed scratch file into an immutable,
 * durably retained artifact version (POST /file/artifact). It needs a
 * session in scope — the artifact store is session-addressed — so the
 * control only exists when one is.
 */
export function artifactControl(input: {
  session: boolean
  busy: boolean
  dirty: boolean
}): { id: "artifact"; label: string; disabled: boolean } | undefined {
  if (!input.session) return
  return {
    id: "artifact",
    label: input.busy ? "Saving result…" : input.dirty ? "Save file first" : "Save as Result",
    disabled: input.busy || input.dirty,
  }
}

export function reconcileSavedDraft(current: string, submitted: string, saved: string) {
  return { draft: current === submitted ? saved : current, saved }
}

export async function readFile(reader: () => Promise<FileData>): Promise<{ data?: FileData; error?: Error }> {
  return reader().then(
    (data) => ({ data }),
    (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  )
}
