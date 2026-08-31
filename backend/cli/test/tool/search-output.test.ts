import { describe, expect, test } from "bun:test"
import { SearchOutput } from "../../src/research/search-output"
import { Truncate } from "../../src/tool/truncation"

function payload(text: string) {
  return {
    operation_id: "operation-fixture",
    status: "completed",
    provider: "gateway",
    funding: "wallet",
    wallet_charge_microusd: 825,
    provider_usage_pending: false,
    provider_credits_used: 5,
    billing: { provider_usage_verified: true, provider_credits_used: 5 },
    warnings: ["Fixture upstream warning"],
    results: [{ url: "https://example.test/paper?complete=source#section", title: "Paper", markdown: text }],
    search_details: { source: "web", mode: "deep", returned_count: 1, enriched_count: 1, ranking: "provider" },
  }
}

function parse(output: string) {
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(Truncate.MAX_BYTES)
  expect(output.split("\n").length).toBeLessThanOrEqual(Truncate.MAX_LINES)
  return JSON.parse(output)
}

describe("structured research search output", () => {
  test("normal payloads and their pretty JSON remain unchanged", () => {
    const value = payload("# Evidence\n\nA small page.")
    const before = structuredClone(value)
    expect(SearchOutput.format(value)).toEqual({
      output: JSON.stringify(value, null, 2),
      resultCount: 1,
      truncated: false,
    })
    expect(value).toEqual(before)
    expect(SearchOutput.format({ status: "partial", message: "Unavailable" }).resultCount).toBeUndefined()
  })

  test.each(["科学".repeat(24_000), '\u0000\u0001\n\\"'.repeat(12_000), "🧬🧪".repeat(18_000)])(
    "serialized byte limits retain valid JSON, Unicode, URLs and accounting",
    async (text) => {
      const value = payload(text)
      const formatted = SearchOutput.format(value)
      const result = parse(formatted.output)
      expect(formatted.truncated).toBe(true)
      expect(formatted.resultCount).toBe(1)
      expect(result.results[0].url).toBe(value.results[0]!.url)
      expect(result.results[0].markdown.isWellFormed()).toBe(true)
      expect(text.startsWith(result.results[0].markdown)).toBe(true)
      expect(result.results[0].content_truncated).toBe(true)
      expect(result.warnings).toContain(value.warnings[0])
      expect(result.warnings.length).toBe(2)
      for (const key of [
        "operation_id",
        "funding",
        "wallet_charge_microusd",
        "provider_usage_pending",
        "provider_credits_used",
        "billing",
        "search_details",
      ] as const)
        expect(result[key]).toEqual(value[key])
      expect((await Truncate.output(formatted.output)).truncated).toBe(false)
      expect(value.results[0]!.markdown).toBe(text)
    },
  )

  test("large pretty line counts compact without dropping results", () => {
    const value = { results: Array.from({ length: 700 }, (_, index) => ({ url: `https://e.test/${index}` })) }
    expect(JSON.stringify(value, null, 2).split("\n").length).toBeGreaterThan(Truncate.MAX_LINES)
    const formatted = SearchOutput.format(value)
    expect(formatted.truncated).toBe(false)
    expect(formatted.resultCount).toBe(700)
    expect(parse(formatted.output)).toEqual(value)
  })

  test("all result text fields are bounded and exhausted enrichment is recounted", () => {
    const value = payload("X".repeat(90_000))
    Object.assign(value.results[0]!, {
      content: "中".repeat(30_000),
      snippet: "Y".repeat(90_000),
      description: "Z".repeat(90_000),
      title: "🧬".repeat(30_000),
    })
    const formatted = SearchOutput.format(value)
    const result = parse(formatted.output)
    expect(formatted.truncated).toBe(true)
    expect(result.results[0].url).toBe(value.results[0]!.url)
    expect(result.results[0].content_truncated).toBe(true)
    expect(result.search_details.enriched_count).toBe(
      Number(Boolean(result.results[0].markdown?.trim() || result.results[0].content?.trim())),
    )
  })

  test("overlong source envelopes drop trailing results without ever cutting URLs", () => {
    const value = {
      ...payload(""),
      results: Array.from({ length: 10 }, (_, index) => ({ url: `https://example.test/${index}?${"q".repeat(8000)}` })),
    }
    const formatted = SearchOutput.format(value)
    const result = parse(formatted.output)
    expect(formatted.truncated).toBe(true)
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results.length).toBeLessThan(10)
    expect(result.results).toEqual(value.results.slice(0, result.results.length))
    expect(formatted.resultCount).toBe(result.results.length)
    expect(result.search_details.returned_count).toBe(result.results.length)
    expect(result.search_details.enriched_count).toBe(0)
    expect(result.wallet_charge_microusd).toBe(825)
  })

  test("unknown oversized envelopes produce bounded partial JSON without raw text", () => {
    const value = { ...payload("evidence"), unexpected: "DO_NOT_ECHO_PRIVATE_RAW_TEXT".repeat(10_000) }
    const formatted = SearchOutput.format(value)
    const result = parse(formatted.output)
    expect(formatted.truncated).toBe(true)
    expect(formatted.resultCount).toBe(0)
    expect(result.status).toBe("partial")
    expect(result.retryable).toBe(false)
    expect(result.operation_id).toBe(value.operation_id)
    expect(result.billing).toEqual(value.billing)
    expect(result.wallet_charge_microusd).toBe(825)
    expect(result.search_details.returned_count).toBe(0)
    expect(result.search_details.enriched_count).toBe(0)
    expect(formatted.output).not.toContain("DO_NOT_ECHO_PRIVATE_RAW_TEXT")
  })

  test("unserializable input does not leak exceptions or invalid JSON", () => {
    const circular: Record<string, unknown> = { private: "DO_NOT_ECHO_PRIVATE_RAW_TEXT" }
    circular.self = circular
    for (const value of [
      undefined,
      1n,
      circular,
      {
        toJSON: () => {
          throw new Error("DO_NOT_ECHO_PRIVATE_RAW_TEXT")
        },
      },
    ]) {
      const result = SearchOutput.format(value)
      expect(parse(result.output).status).toBe("partial")
      expect(result.truncated).toBe(true)
      expect(result.output).not.toContain("DO_NOT_ECHO_PRIVATE_RAW_TEXT")
    }
  })
})
