import type { MessageV2 } from "./message-v2"

export namespace SearchDedupe {
  const RESEARCH_SEARCH_IDS = new Set(["research_search", "websearch"])

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

  /**
   * Persisted `websearch` calls used the Exa-shaped argument names. During the
   * migration both names are one logical capability, so map the legacy shape
   * into the public `research_search` contract before hashing. This keeps a
   * resumed session from spending a second managed search for the same call.
   */
  export function normalize(tool: string, value: unknown): unknown {
    if (!RESEARCH_SEARCH_IDS.has(tool) || !value || typeof value !== "object" || Array.isArray(value)) return value
    const input = value as Record<string, unknown>
    const rawMode = input.mode ?? input.type
    const mode = rawMode === "fast" || rawMode === "deep" ? rawMode : "balanced"
    return {
      query: input.query,
      source: input.source ?? "web",
      mode,
      limit: input.limit ?? input.numResults ?? 8,
      content: input.content ?? "snippets",
      ...(input.include_domains !== undefined ? { include_domains: input.include_domains } : {}),
      ...(input.exclude_domains !== undefined ? { exclude_domains: input.exclude_domains } : {}),
      ...(input.published_after !== undefined ? { published_after: input.published_after } : {}),
      ...(input.published_before !== undefined ? { published_before: input.published_before } : {}),
    }
  }

  function equivalent(left: string, right: string) {
    if (left === right) return true
    return RESEARCH_SEARCH_IDS.has(left) && RESEARCH_SEARCH_IDS.has(right)
  }

  export function applies(tool: string, input: Record<string, unknown>) {
    if (RESEARCH_SEARCH_IDS.has(tool) || tool === "codesearch" || tool === "science_search") return true
    if (tool.startsWith("query_")) return true
    if (tool !== "atlas") return false
    return input.operation === "search" || input.operation === "ask"
  }

  export function key(tool: string, value: unknown) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
    if (!applies(tool, input)) return
    return signature(normalize(tool, input))
  }

  function completedSignature(part: MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }) {
    // Legacy search signatures were computed before argument normalization and
    // therefore cannot be compared to the canonical tool. Recompute them from
    // the persisted input. Other tools retain their stored signature contract.
    if (RESEARCH_SEARCH_IDS.has(part.tool)) return signature(normalize(part.tool, part.state.input))
    const stored = part.state.metadata.dedupeSignature
    if (typeof stored === "string" && /^[a-f0-9]{64}$/.test(stored)) return stored
    // Calls completed before canonical signatures were persisted retain the
    // legacy exact-input behavior. Re-executing once is safer than applying
    // today's schema defaults to an output produced under an older schema.
    return signature(part.state.input)
  }

  function dynamicTerminal(part: MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }) {
    if (!RESEARCH_SEARCH_IDS.has(part.tool)) return false
    try {
      const output = JSON.parse(part.state.output) as Record<string, unknown>
      return output.type === "search_unavailable" || output.type === "search_allowance_exhausted"
    } catch {
      return false
    }
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
        (part) =>
          equivalent(part.tool, tool) &&
          completedSignature(part) === expected &&
          !dynamicTerminal(part) &&
          part.state.metadata.dedupeHit !== true,
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
