import { Truncate } from "../tool/truncation"

/** Bound the serialized tool contract, not just the source text: JSON escaping
 * and multibyte characters must never send valid results to plain truncation. */
export namespace SearchOutput {
  const warning =
    "Search output was reduced to fit the tool limit. Some result text or trailing results were omitted; use retained source URLs for complete pages."
  const unavailable =
    "The best-effort free search fallback returned no usable content. This is a degraded search-provider outcome, not evidence that the query has no matches or that outbound network access is blocked. Connect Firecrawl in Customize → Connectors or use a funded Ace Wallet; science_search, science_fetch, and WebFetch remain available alternatives."
  const fields = ["markdown", "content", "snippet", "description", "title"] as const

  function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function fits(output: string) {
    return Buffer.byteLength(output, "utf8") <= Truncate.MAX_BYTES && output.split("\n").length <= Truncate.MAX_LINES
  }

  function count(value: unknown) {
    return record(value) && Array.isArray(value.results) ? value.results.length : undefined
  }

  function recount(value: Record<string, unknown>, results: unknown[]) {
    if (!record(value.search_details)) return
    value.search_details.returned_count = results.length
    value.search_details.enriched_count = results.filter(
      (item) => record(item) && [item.markdown, item.content].some((text) => typeof text === "string" && text.trim()),
    ).length
  }

  /** Convert only the hosted provider's explicit degraded sentinel. Empty
   * results without this exact funding/warning combination are valid search
   * outcomes and must remain completed. Callers that re-filter cached results
   * use format() directly so a locally emptied cache is never reclassified. */
  export function classify(value: unknown) {
    if (
      !record(value) ||
      value.status !== "completed" ||
      value.funding !== "free_fallback" ||
      !Array.isArray(value.results) ||
      value.results.length !== 0 ||
      !Array.isArray(value.warnings) ||
      !value.warnings.includes("search_content_unavailable")
    )
      return
    return {
      ...value,
      status: "partial" as const,
      type: "search_unavailable" as const,
      message: unavailable,
      retryable: false as const,
      alternatives: ["science_search", "science_fetch", "WebFetch"] as const,
    }
  }

  function prefix(value: string, budget: number) {
    // Binary search serialized bytes; a control character may cost six bytes.
    // Move a UTF-16 boundary back when it would split a surrogate pair.
    const state = { low: 0, high: value.length }
    const slice = (length: number) => {
      const split =
        length > 0 && /[\uD800-\uDBFF]/.test(value[length - 1]!) && /[\uDC00-\uDFFF]/.test(value[length] ?? "")
      return value.slice(0, length - Number(split))
    }
    while (state.low < state.high) {
      const middle = Math.ceil((state.low + state.high) / 2)
      if (Buffer.byteLength(JSON.stringify(slice(middle)), "utf8") <= budget) state.low = middle
      else state.high = middle - 1
    }
    return slice(state.low)
  }

  function fallback(value?: unknown): {
    output: string
    resultCount: number
    truncated: true
    unavailable: true
    stopReason: "search_output_unavailable"
  } {
    // An oversized/unknown envelope cannot be echoed in an exception or cut in
    // half. Retain bounded recognized financial fields, never arbitrary text.
    const keys = [
      "operation_id",
      "provider",
      "funding",
      "wallet_charge_microusd",
      "provider_usage_pending",
      "provider_credits_used",
      "billing",
      "allowance",
      "cache",
      "search_details",
    ]
    const source = record(value) ? value : {}
    const retained = Object.fromEntries(
      keys.flatMap((key) => {
        const text = JSON.stringify(source[key])
        return text !== undefined && Buffer.byteLength(text, "utf8") <= 2048 ? [[key, source[key]]] : []
      }),
    )
    const warnings = Array.isArray(source.warnings)
      ? source.warnings
          .filter((item) => typeof item === "string" && Buffer.byteLength(JSON.stringify(item), "utf8") <= 512)
          .slice(0, 20)
      : []
    const result = {
      ...retained,
      status: "partial",
      type: "search_output_unavailable",
      retryable: false,
      results: [],
      warnings: [
        ...warnings,
        "The search response envelope could not fit the tool limit. Results and oversized metadata were omitted. No additional search was issued; do not repeat a paid search solely to recover this output.",
      ],
    }
    recount(result, result.results)
    return {
      output: JSON.stringify(result),
      resultCount: 0,
      truncated: true,
      unavailable: true,
      stopReason: "search_output_unavailable",
    }
  }

  export function format(value: unknown): {
    output: string
    resultCount?: number
    truncated: boolean
    unavailable?: true
    stopReason?: "search_output_unavailable"
  } {
    const encoded = (() => {
      try {
        const output = JSON.stringify(value, null, 2)
        return output === undefined ? undefined : { output, value: JSON.parse(output) as unknown }
      } catch {
        return undefined
      }
    })()
    if (!encoded) return fallback()
    if (fits(encoded.output)) return { output: encoded.output, resultCount: count(encoded.value), truncated: false }
    const compact = JSON.stringify(encoded.value)
    if (fits(compact)) return { output: compact, resultCount: count(encoded.value), truncated: false }
    if (!record(encoded.value) || !Array.isArray(encoded.value.results)) return fallback(encoded.value)
    const data = encoded.value
    const results = data.results as unknown[]
    data.warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), warning]
    while (true) {
      recount(data, results)
      const output = JSON.stringify(data)
      if (fits(output)) return { output, resultCount: results.length, truncated: true }
      const largest = results
        .flatMap((item) => {
          if (!record(item)) return []
          return fields.flatMap((key) => {
            const text = item[key]
            return typeof text === "string" && text.length
              ? [{ item, key, text, size: Buffer.byteLength(JSON.stringify(text), "utf8") }]
              : []
          })
        })
        .sort((a, b) => b.size - a.size)[0]
      if (largest) {
        const budget = Math.max(0, largest.size - (Buffer.byteLength(output, "utf8") - Truncate.MAX_BYTES) - 64)
        const text = prefix(largest.text, budget)
        if (text) largest.item[largest.key] = text
        else delete largest.item[largest.key]
        largest.item.content_truncated = true
        continue
      }
      if (!results.length) return fallback(data)
      results.pop()
    }
  }

  /** Format a fresh hosted-provider response after applying its dynamic
   * availability signal. Cached responses deliberately bypass this boundary. */
  export function provider(value: unknown) {
    const classified = classify(value)
    const formatted = format(classified ?? value)
    if (!classified || formatted.unavailable) return formatted
    return { ...formatted, unavailable: true as const, stopReason: "search_unavailable" as const }
  }
}
