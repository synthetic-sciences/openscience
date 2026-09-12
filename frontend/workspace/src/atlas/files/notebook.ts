import stripAnsi from "strip-ansi"

export type NotebookOutput =
  { kind: "text" | "error" | "markdown" | "html"; text: string } | { kind: "image"; src: string }

export type NotebookCell = {
  type: "markdown" | "code" | "raw"
  source: string
  language: string
  count?: number
  label?: string
  attachments?: Record<string, unknown>
  outputs: NotebookOutput[]
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const multiline = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((line) => typeof line === "string")
      ? value.join("")
      : undefined

export function notebookImage(value: unknown): string | undefined {
  const data = object(value)
  for (const mime of ["image/png", "image/jpeg", "image/svg+xml"]) {
    const content = multiline(data?.[mime])
    if (!content) continue
    if (mime === "image/svg+xml")
      return `data:${mime},${encodeURIComponent(content).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`
    const encoded = content.replace(/\s/g, "")
    if (/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) return `data:${mime};base64,${encoded}`
  }
}

/** Resolve embedded attachments before Markdown sanitization removes their private URI scheme. */
export function notebookMarkdown(text: string, attachments?: Record<string, unknown>) {
  return text.replace(/\battachment:([^\s)>"']+)/g, (source, name: string) => {
    const decoded = (() => {
      try {
        return decodeURIComponent(name)
      } catch {
        return name
      }
    })()
    return notebookImage(attachments?.[decoded]) ?? source
  })
}

export function notebookOutputs(value: unknown): NotebookOutput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): NotebookOutput[] => {
    const output = object(entry)
    if (!output) return []
    if (output.output_type === "error") {
      const traceback = Array.isArray(output.traceback)
        ? output.traceback.filter((line): line is string => typeof line === "string").join("\n")
        : ""
      return [{ kind: "error", text: stripAnsi(traceback || `${output.ename ?? "Error"}: ${output.evalue ?? ""}`) }]
    }
    const text = multiline(output.text)
    if (text !== undefined) return [{ kind: "text", text: stripAnsi(text) }]
    const data = object(output.data)
    const image = notebookImage(data)
    if (image) return [{ kind: "image", src: image }]
    for (const [mime, kind] of [
      ["text/html", "html"],
      ["text/markdown", "markdown"],
      ["text/plain", "text"],
    ] as const) {
      const content = multiline(data?.[mime])
      if (content !== undefined) return [{ kind, text: kind === "text" ? stripAnsi(content) : content }]
    }
    return [{ kind: "text", text: "This output format is not supported in the preview." }]
  })
}

export function notebookLanguage(value: string) {
  const language = value.toLowerCase()
  if (language === "r" || language === "ir") return "r"
  if (/^python(?:[\d.]+)?$/.test(language)) return "python"
  return language
}

export function parseNotebook(text: string): { cells: NotebookCell[]; error?: string } {
  const parsed = (() => {
    try {
      return object(JSON.parse(text))
    } catch {
      return undefined
    }
  })()
  const invalid = { cells: [], error: "This notebook could not be previewed. Open Edit to inspect its JSON source." }
  if (parsed?.nbformat !== 4 || !Array.isArray(parsed.cells)) return invalid
  const metadata = object(parsed.metadata)
  const kernel = object(metadata?.kernelspec)
  const language = notebookLanguage(
    String(object(metadata?.language_info)?.name ?? kernel?.language ?? kernel?.name ?? "python"),
  )
  const cells: NotebookCell[] = []
  for (const value of parsed.cells) {
    const cell = object(value)
    const source = multiline(cell?.source)
    if (!cell || source === undefined || !["markdown", "code", "raw"].includes(String(cell.cell_type))) return invalid
    cells.push({
      type: cell.cell_type as NotebookCell["type"],
      source,
      language,
      count: typeof cell.execution_count === "number" ? cell.execution_count : undefined,
      attachments: object(cell.attachments),
      outputs: notebookOutputs(cell.outputs),
    })
  }
  return { cells }
}

/** Split executable fenced chunks while leaving ordinary Markdown fences intact. */
export function parseComputationalMarkdown(text: string): { cells: NotebookCell[]; error?: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const cells: NotebookCell[] = []
  const prose: string[] = []
  const flush = () => {
    if (prose.join("\n").trim()) cells.push({ type: "markdown", source: prose.join("\n"), language: "", outputs: [] })
    prose.length = 0
  }
  for (let index = 0; index < lines.length; index++) {
    if (index === 0 && lines[index] === "---") {
      const end = lines.findIndex((line, offset) => offset > 0 && /^(---|\.\.\.)\s*$/.test(line))
      if (end > 0) {
        cells.push({
          type: "raw",
          label: "Document options",
          source: lines.slice(1, end).join("\n"),
          language: "yaml",
          outputs: [],
        })
        index = end
        continue
      }
    }
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[index])
    if (!opening) {
      prose.push(lines[index])
      continue
    }
    const fence = opening[2]
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`)
    const end = (() => {
      for (let offset = index + 1; offset < lines.length; offset++) {
        if (closing.test(lines[offset])) return offset
      }
      return -1
    })()
    const chunk = /^\{([\w+-]+)(?:[\s,]+([^}]*))?\}\s*$/.exec(opening[3].trim())
    if (!chunk || end < 0) {
      const last = end < 0 ? lines.length - 1 : end
      prose.push(lines.slice(index, last + 1).join("\n"))
      index = last
      continue
    }
    flush()
    cells.push({
      type: "code",
      source: lines.slice(index + 1, end).join("\n"),
      language: notebookLanguage(chunk[1]),
      label: chunk[2]?.split(",")[0]?.trim(),
      outputs: [],
    })
    index = end
  }
  flush()
  return { cells }
}

export function notebookHtml(text: string) {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font:14px system-ui;margin:12px;overflow-wrap:anywhere}img,svg{max-width:100%}table{border-collapse:collapse}td,th{padding:6px 12px;border:1px solid #bbb}</style>${text}`
}
