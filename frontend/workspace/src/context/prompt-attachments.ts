import type { ContentPart, Prompt } from "./prompt"

/**
 * Attachment bytes stay in memory. A draft is persisted on every keystroke,
 * and a data URL of several megabytes blew through the browser's storage
 * quota: the write evicted every other key of the workspace (other drafts,
 * layout, model choice) and then disabled persistence for the page. Only the
 * attachment's identity is stored; an attachment cannot outlive the page.
 */
const attachmentBytes = new Map<string, string>()

export function detachBytes(prompt: Prompt): Prompt {
  return prompt.map((part) => {
    if (part.type !== "image") return part
    if (part.dataUrl) attachmentBytes.set(part.id, part.dataUrl)
    return { ...part, dataUrl: "" }
  })
}

export function attachBytes(prompt: Prompt): Prompt {
  return prompt.map((part) =>
    part.type === "image" ? { ...part, dataUrl: attachmentBytes.get(part.id) ?? part.dataUrl } : part,
  )
}

/** A stored draft's attachments have no bytes after a reload; drop them. */
export function dropBytelessAttachments(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { prompt?: unknown }).prompt)) return value
  const draft = value as { prompt: ContentPart[] }
  const prompt = draft.prompt.filter((part) => part?.type !== "image" || attachmentBytes.has(part.id))
  return prompt.length === draft.prompt.length ? value : { ...draft, prompt }
}
