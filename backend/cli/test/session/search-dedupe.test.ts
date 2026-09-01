import { expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { SearchDedupe } from "../../src/session/search-dedupe"

const part: MessageV2.ToolPart = {
  id: "part_search",
  sessionID: "ses_search",
  messageID: "msg_search",
  type: "tool",
  callID: "call_search",
  tool: "websearch",
  state: {
    status: "completed",
    input: { numResults: 4, query: "protein folding" },
    output: "grounded results",
    title: "Web search",
    metadata: {},
    time: { start: 100, end: 150 },
  },
}

const message: MessageV2.WithParts = {
  info: {
    id: "msg_search",
    sessionID: "ses_search",
    role: "assistant",
    time: { created: 90, completed: 160 },
    parentID: "msg_user",
    modelID: "model",
    providerID: "provider",
    mode: "research",
    agent: "research",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [part],
}

test("reuses one completed identical search and marks the new call as a dedupe hit", () => {
  expect(SearchDedupe.signature({ query: "x", top: 3 })).toBe(SearchDedupe.signature({ top: 3, query: "x" }))
  const hit = SearchDedupe.find([message], "websearch", { query: "protein folding", numResults: 4 })
  expect(hit?.id).toBe("part_search")
  expect(hit && SearchDedupe.reuse(hit)).toMatchObject({
    output: "grounded results",
    metadata: {
      dedupeHit: true,
      dedupeOf: {
        messageID: "msg_search",
        partID: "part_search",
        callID: "call_search",
      },
    },
  })
  expect(SearchDedupe.find([message], "websearch", { query: "different", numResults: 4 })).toBeUndefined()
  expect(SearchDedupe.find([message], "read", { filePath: "/tmp/file" })).toBeUndefined()
})

test("dedupes a canonical research_search call against legacy websearch history", () => {
  const hit = SearchDedupe.find([message], "research_search", {
    query: "protein folding",
    source: "web",
    mode: "balanced",
    limit: 4,
    content: "snippets",
  })
  expect(hit?.id).toBe("part_search")
  expect(SearchDedupe.key("research_search", { query: "protein folding", limit: 4 })).toBe(
    SearchDedupe.key("websearch", { query: "protein folding", numResults: 4 }),
  )
})

test("does not dedupe dynamic unavailable or exhausted search results", () => {
  const dynamic = (
    type: "search_unavailable" | "search_allowance_exhausted",
    retryable?: boolean,
  ): MessageV2.WithParts => ({
    ...message,
    parts: [
      {
        ...part,
        tool: "research_search",
        state: {
          status: "completed",
          input: {
            query: "protein folding",
            source: "web",
            mode: "balanced",
            limit: 4,
            content: "snippets",
          },
          output: JSON.stringify({
            status: "completed",
            type,
            retryable,
            alternatives: ["science_search", "science_fetch", "WebFetch"],
          }),
          title: "Gateway search unavailable",
          metadata: {},
          time: { start: 100, end: 150 },
        },
      },
    ],
  })
  for (const prior of [
    dynamic("search_unavailable", true),
    dynamic("search_unavailable", false),
    dynamic("search_allowance_exhausted"),
  ]) {
    expect(
      SearchDedupe.find([prior], "research_search", {
        query: "protein folding",
        source: "web",
        mode: "balanced",
        limit: 4,
        content: "snippets",
      }),
    ).toBeUndefined()
  }
})

function completed(input: Record<string, unknown>, output: unknown, tool = "research_search") {
  return {
    ...part,
    tool,
    state: {
      status: "completed" as const,
      input,
      output: typeof output === "string" ? output : JSON.stringify(output),
      title: "Research search",
      metadata: {
        resultCount: 6,
        creditState: "wallet",
        operationID: "original_operation",
        dedupeSignature: SearchDedupe.key(tool, input),
      },
      time: { start: 100, end: 150 },
    },
  }
}

test("raw degraded free fallback is not cache-eligible while a genuine empty result stays cached", () => {
  const input = {
    query: "protein folding",
    source: "web",
    mode: "balanced",
    limit: 4,
    content: "snippets",
  }
  const unavailable = completed(input, {
    status: "completed",
    provider: "free_search",
    funding: "free_fallback",
    results: [],
    warnings: ["free_search_fallback", "search_content_unavailable"],
  })
  const empty = completed(input, {
    status: "completed",
    provider: "free_search",
    funding: "free_fallback",
    results: [],
    warnings: ["free_search_fallback"],
  })

  expect(SearchDedupe.find([{ ...message, parts: [unavailable] }], "research_search", input)).toBeUndefined()
  expect(SearchDedupe.find([{ ...message, parts: [empty] }], "research_search", input)).toBe(empty)
})

test("cache filtering to zero never reclassifies a previously usable provider response", () => {
  const input = {
    query: "protein folding",
    source: "web",
    mode: "balanced",
    limit: 4,
    content: "snippets",
    include_domains: ["allowed.example"],
  }
  const original = completed(input, {
    status: "completed",
    provider: "free_search",
    funding: "free_fallback",
    results: [{ url: "https://outside.example/paper", title: "Outside" }],
    warnings: ["free_search_fallback", "search_content_unavailable"],
    search_details: { returned_count: 1, enriched_count: 0 },
  })
  original.state.metadata.creditState = "free_fallback"
  const hit = SearchDedupe.find([{ ...message, parts: [original] }], "research_search", input)
  expect(hit).toBe(original)

  const cached = SearchDedupe.reuse(hit!)
  const output = JSON.parse(cached.output)
  expect(output).toMatchObject({ status: "completed", funding: "free_fallback", results: [] })
  expect(output.type).toBeUndefined()
  expect(output.warnings).toContain("search_content_unavailable")
  expect(output.warnings.join(" ")).toContain("outside the requested domain restrictions")
  expect(cached.title).toBe(original.state.title)
  expect(cached.metadata.outcome).toBeUndefined()
  expect(cached.metadata.stopReason).toBeUndefined()
  expect(cached.metadata.dedupeHit).toBe(true)
})

test("rechecks cached developer results without changing original accounting or provenance", () => {
  const input = {
    query: "Python documentation",
    source: "developer",
    include_domains: ["docs.python.org"],
    published_after: "2026-01-01",
    published_before: "2026-08-30",
  }
  const original = completed(input, {
    provider: "firecrawl",
    funding: "wallet",
    operation_id: "original_operation",
    wallet_charge_microusd: 1000,
    provider_credits_used: 6,
    pending_usage: false,
    results: [
      { url: "https://docs.python.org/3/", title: "Python", published_at: "2026-01-01", markdown: "Docs" },
      { url: "https://docs.python.org/3/latest", published_at: "2026-08-30T23:00:00Z" },
      { url: "https://medium.com/python", published_at: "2026-04-01", content: "Not allowed" },
      { url: "https://docs.python.org/3/undated", content: "No date" },
      { url: "https://docs.python.org/3/old", published_at: "2025-12-31" },
      { url: "https://docs.python.org.evil.example/", published_at: "2026-04-01" },
    ],
    search_details: {
      requested_limit: 8,
      effective_limit: 8,
      returned_count: 6,
      enriched_count: 3,
      ranking: "provider",
    },
    warnings: ["Original provider warning"],
  })
  const snapshot = JSON.stringify(original)
  const hit = SearchDedupe.find([{ ...message, parts: [original] }], "research_search", input)
  expect(hit).toBe(original)
  const result = SearchDedupe.reuse(hit!)
  const output = JSON.parse(result.output)
  expect(output.results).toEqual([
    { url: "https://docs.python.org/3/", title: "Python", published_at: "2026-01-01", markdown: "Docs" },
    { url: "https://docs.python.org/3/latest", published_at: "2026-08-30T23:00:00Z" },
  ])
  expect(output).toMatchObject({
    provider: "firecrawl",
    funding: "wallet",
    operation_id: "original_operation",
    wallet_charge_microusd: 1000,
    provider_credits_used: 6,
    pending_usage: false,
    search_details: {
      requested_limit: 8,
      effective_limit: 8,
      returned_count: 2,
      enriched_count: 1,
      ranking: "provider",
    },
  })
  expect(output.warnings).toContain("Original provider warning")
  expect(output.warnings.join(" ")).toContain("2 results outside the requested domain restrictions")
  expect(output.warnings.join(" ")).toContain("1 results without an absolute provider-reported publication date")
  expect(output.warnings.join(" ")).toContain("1 results outside the requested publication-date range")
  expect(output.warnings.join(" ")).toContain("No new provider request or search charge was made")
  expect(result.metadata).toMatchObject({
    resultCount: 2,
    creditState: "wallet",
    operationID: "original_operation",
    dedupeSignature: original.state.metadata.dedupeSignature,
    dedupeHit: true,
    dedupeOf: { messageID: "msg_search", partID: "part_search", callID: "call_search" },
  })
  expect(JSON.stringify(original)).toBe(snapshot)
})

test("cached date filters cannot use relative dates, crawl dates, snippets, or URL dates as publication evidence", () => {
  const original = completed(
    { query: "new research", published_after: "2026-08-01" },
    {
      results: [
        { url: "https://example.org/relative", published_at: "2 days ago" },
        { url: "https://example.org/crawled", crawled_at: "2026-08-20" },
        { url: "https://example.org/2026-08-20/paper", snippet: "Published 2026-08-20" },
        { url: "https://example.org/invalid", published_at: "2026-02-30" },
      ],
    },
  )
  const result = SearchDedupe.reuse(original)
  expect(JSON.parse(result.output).results).toEqual([])
  expect(result.metadata.resultCount).toBe(0)
  expect(JSON.parse(result.output).warnings.join(" ")).toContain(
    "4 results without an absolute provider-reported publication date",
  )
})

test("legacy websearch replays enforce domain exclusions and safe unique source URLs", () => {
  const original = completed(
    { query: "protein folding", numResults: 4, exclude_domains: ["example.com"] },
    {
      results: [
        { url: "https://sub.example.com/blocked" },
        { url: "https://example.org/paper#results", title: "Retained" },
        { url: "https://example.org/paper#methods" },
        { url: "file:///tmp/private" },
        { url: "https://user:secret@example.org/" },
        null,
      ],
    },
    "websearch",
  )
  const hit = SearchDedupe.find([{ ...message, parts: [original] }], "research_search", {
    query: "protein folding",
    limit: 4,
    exclude_domains: ["example.com"],
  })
  expect(hit).toBe(original)
  const result = SearchDedupe.reuse(hit!)
  expect(JSON.parse(result.output).results).toEqual([{ url: "https://example.org/paper#results", title: "Retained" }])
  expect(result.metadata.resultCount).toBe(1)
})

test("filtered legacy text is omitted explicitly while retaining the original cache hit", () => {
  for (const output of [
    "Legacy result without source metadata",
    { summary: "Legacy result", wallet_charge_microusd: 900 },
  ]) {
    const input = { query: "filtered legacy result", published_before: "2026-08-30" }
    const original = completed(input, output, "websearch")
    const history = [{ ...message, parts: [original] }]
    const result = SearchDedupe.reuse(original)
    const parsed = JSON.parse(result.output)
    expect(parsed.results).toEqual([])
    expect(parsed.warnings.join(" ")).toContain("without structured source/date metadata")
    expect(parsed.warnings.join(" ")).toContain("No new provider request or search charge was made")
    expect(parsed.summary).toBeUndefined()
    expect(result.metadata.resultCount).toBe(0)
    expect(result.metadata.dedupeHit).toBe(true)
    if (typeof output !== "string") expect(parsed.wallet_charge_microusd).toBe(900)
    // Keep the cache eligible; dropping it would cause a second paid request.
    expect(SearchDedupe.find(history, "research_search", input)).toBe(original)
  }
})

test("invalid persisted filters fail closed without breaking dedupe or throwing", () => {
  for (const filters of [
    { published_after: "2026-02-30" },
    { published_after: "2026-08-30", published_before: "2026-08-01" },
    { published_after: "" },
    { include_domains: "example.org" },
    { include_domains: [null] },
    { include_domains: ["https://example.org/path"] },
    { include_domains: ["example.org"], exclude_domains: ["example.net"] },
  ]) {
    const original = completed(
      { query: "legacy search", ...filters },
      {
        results: [{ url: "https://example.org/", published_at: "2026-08-20" }],
      },
    )
    const result = SearchDedupe.reuse(original)
    expect(JSON.parse(result.output).results).toEqual([])
    expect(JSON.parse(result.output).warnings.join(" ")).toContain(
      "persisted domain/date filters could not be validated",
    )
    expect(result.metadata.resultCount).toBe(0)
    expect(SearchDedupe.find([{ ...message, parts: [original] }], "research_search", original.state.input)).toBe(
      original,
    )
  }
})

test("non-research search output is not rewritten", () => {
  const original = completed({ query: "protein folding" }, { results: [{ url: "internal:paper" }] }, "science_search")
  const result = SearchDedupe.reuse(original)
  expect(result.output).toBe(original.state.output)
  expect(result.metadata.resultCount).toBe(6)
  expect(result.metadata.dedupeHit).toBe(true)
})
