import type { ResearchSearchInput } from "@/openscience"
import { SearchFilters } from "@/research/search-filters"
import { SearchOutput } from "@/research/search-output"
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
      return (
        output.type === "search_unavailable" ||
        output.type === "credits_exhausted" ||
        output.type === "search_allowance_exhausted" ||
        SearchOutput.classify(output) !== undefined
      )
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

  function record(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  }

  function cached(part: MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }) {
    if (!RESEARCH_SEARCH_IDS.has(part.tool)) return
    const input = normalize(part.tool, part.state.input) as ResearchSearchInput
    const restricted = [
      input.include_domains,
      input.exclude_domains,
      input.published_after,
      input.published_before,
    ].some((value) => value !== undefined && (!Array.isArray(value) || value.length > 0))
    const output = (() => {
      try {
        return record(JSON.parse(part.state.output))
      } catch {
        return undefined
      }
    })()
    // Older unfiltered websearch calls can contain plain text. Keep that format
    // compatible, but never replay unverifiable text as a filtered result.
    if (!Array.isArray(output?.results) && !restricted) return
    const filtered = (() => {
      if (!Array.isArray(output?.results))
        return {
          results: [],
          warnings: [
            "Omitted cached results without structured source/date metadata required to verify the requested filters.",
          ],
        }
      try {
        // Persisted inputs predate current parameter validation. Invalid legacy
        // filters must fail closed, without invalidating the paid-search cache.
        if (input.published_after !== undefined) SearchFilters.Date.parse(input.published_after)
        if (input.published_before !== undefined) SearchFilters.Date.parse(input.published_before)
        SearchFilters.tbs(input)
        for (const domains of [input.include_domains, input.exclude_domains]) {
          if (domains === undefined) continue
          if (
            !Array.isArray(domains) ||
            domains.some(
              (domain) =>
                typeof domain !== "string" ||
                !domain ||
                /[:/\s]/.test(domain) ||
                URL.parse(`https://${domain}`)?.hostname !== domain.toLowerCase(),
            )
          )
            throw new Error("Invalid cached domain filters")
        }
        if (input.include_domains?.length && input.exclude_domains?.length)
          throw new Error("Conflicting cached domain filters")
        const results = output.results.map(
          (value): Record<string, unknown> & { url: string; published_at?: string } => {
            const result = record(value)
            return {
              ...result,
              url: typeof result?.url === "string" ? result.url : "",
              published_at: typeof result?.published_at === "string" ? result.published_at : undefined,
            }
          },
        )
        return SearchFilters.apply(results, input)
      } catch {
        return {
          results: [],
          warnings: ["Omitted cached results because their persisted domain/date filters could not be validated."],
        }
      }
    })()
    const details = record(output?.search_details)
    // When the legacy payload has no structured results, preserve its original
    // accounting/provenance envelope, not unverifiable free-form search text.
    const envelope = Array.isArray(output?.results)
      ? output
      : Object.fromEntries(
          [
            "status",
            "operation_id",
            "provider",
            "funding",
            "wallet_charge_microusd",
            "provider_usage_pending",
            "provider_credits_used",
            "provider_credits",
            "pending_usage",
            "provenance",
          ].map((key) => [key, output?.[key]]),
        )
    return SearchOutput.format({
      ...envelope,
      results: filtered.results,
      ...(details
        ? {
            search_details: {
              ...details,
              returned_count: filtered.results.length,
              enriched_count: filtered.results.filter(
                (result) =>
                  (typeof result.markdown === "string" && result.markdown.trim().length > 0) ||
                  (typeof result.content === "string" && result.content.trim().length > 0),
              ).length,
            },
          }
        : {}),
      warnings: [
        ...(Array.isArray(output?.warnings) ? output.warnings : []),
        ...filtered.warnings,
        "Reused cached search results after checking available source metadata. No new provider request or search charge was made; any accounting fields describe the original search.",
      ],
    })
  }

  export function reuse(part: MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }) {
    const result = cached(part)
    return {
      title: part.state.title,
      output: result?.output ?? part.state.output,
      attachments: part.state.attachments,
      metadata: {
        ...part.state.metadata,
        ...(result ? { resultCount: result.resultCount, truncated: result.truncated } : {}),
        ...(result?.unavailable
          ? { outcome: "partial", stopReason: result.stopReason ?? "search_output_unavailable" }
          : {}),
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
