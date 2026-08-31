import type { Part, TextPart } from "@synsci/sdk/v2/client"

export function lastResponseTextPart(parts: readonly Part[]) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.type === "text" && !part.synthetic) return part as TextPart
  }
}

/** Match the visible trace: newest value at the first position of each part ID.
 * Preserve source Markdown (including absolute links and indentation), copying
 * prose only, never hidden reasoning, tool output, or synthetic notices. */
export function responseText(parts: readonly Part[]) {
  return [...new Map(parts.map((part) => [part.id, part])).values()]
    .filter((part): part is TextPart => part.type === "text" && !part.synthetic && !!part.text.trim())
    .map((part) => part.text)
    .join("\n\n")
}
