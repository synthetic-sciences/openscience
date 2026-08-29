export type UndoMessage = {
  id: string
  role: "user" | "assistant"
}

export type UndoPart = {
  type: string
  files?: string[]
}

export type UndoPreview = {
  turns: number
  files: string[]
}

function relativeFile(file: string, root?: string) {
  if (!root) return file
  const normalizedRoot = root.replace(/[\\/]+$/, "")
  if (file === normalizedRoot) return file.split(/[\\/]/).at(-1) ?? file
  if (file.startsWith(`${normalizedRoot}/`) || file.startsWith(`${normalizedRoot}\\`)) {
    return file.slice(normalizedRoot.length + 1).replaceAll("\\", "/")
  }
  return file
}

export function undoPreview(
  messages: UndoMessage[],
  parts: Record<string, UndoPart[] | undefined>,
  messageID: string,
  root?: string,
): UndoPreview {
  const start = messages.findIndex((message) => message.id === messageID)
  if (start < 0) return { turns: 0, files: [] }
  const range = messages.slice(start)
  const files = new Set<string>()
  for (const message of range) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== "patch") continue
      for (const file of part.files ?? []) files.add(relativeFile(file, root))
    }
  }
  return {
    turns: range.filter((message) => message.role === "user").length,
    files: [...files].toSorted(),
  }
}

export function shouldConfirmUndo(preview: UndoPreview) {
  return preview.turns > 1 || preview.files.length > 0
}

export function undoSummary(preview: UndoPreview) {
  const turns = `${preview.turns} turn${preview.turns === 1 ? "" : "s"}`
  const files = `${preview.files.length} file${preview.files.length === 1 ? "" : "s"}`
  return `${turns} · ${files}`
}
