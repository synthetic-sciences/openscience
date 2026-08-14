import type { MessageV2 } from "./message-v2"

export namespace SearchDedupe {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }

  export function signature(value: unknown) {
    const hash = new Bun.CryptoHasher("sha256")
    hash.update(JSON.stringify(canonical(value)))
    return hash.digest("hex")
  }

  export function applies(tool: string, input: Record<string, unknown>) {
    if (tool === "websearch" || tool === "codesearch" || tool === "science_search") return true
    if (tool.startsWith("query_")) return true
    if (tool !== "atlas") return false
    return input.operation === "search" || input.operation === "ask"
  }

  export function key(tool: string, value: unknown) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
    if (!applies(tool, input)) return
    return signature(input)
  }

  function completedSignature(part: MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }) {
    const stored = part.state.metadata.dedupeSignature
    if (typeof stored === "string" && /^[a-f0-9]{64}$/.test(stored)) return stored
    // Calls completed before canonical signatures were persisted retain the
    // legacy exact-input behavior. Re-executing once is safer than applying
    // today's schema defaults to an output produced under an older schema.
    return signature(part.state.input)
  }

  export function find(
    messages: MessageV2.WithParts[],
    tool: string,
    value: unknown,
  ): (MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }) | undefined {
    const expected = key(tool, value)
    if (!expected) return
    return messages
      .flatMap((message) => message.parts)
      .filter(
        (part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } =>
          part.type === "tool" && part.state.status === "completed",
      )
      .findLast(
        (part) => part.tool === tool && completedSignature(part) === expected && part.state.metadata.dedupeHit !== true,
      )
  }

  export function reuse(part: MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }) {
    return {
      title: part.state.title,
      output: part.state.output,
      attachments: part.state.attachments,
      metadata: {
        ...part.state.metadata,
        dedupeHit: true,
        dedupeOf: {
          messageID: part.messageID,
          partID: part.id,
          callID: part.callID,
        },
      },
    }
  }
}
