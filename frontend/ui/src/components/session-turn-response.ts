import type { Part, TextPart } from "@synsci/sdk/v2/client"

export function lastResponseTextPart(parts: readonly Part[]) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.type === "text" && !part.synthetic) return part as TextPart
  }
}
