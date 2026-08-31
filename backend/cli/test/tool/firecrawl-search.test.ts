import { expect, test } from "bun:test"
import type { ResearchSearchInput } from "../../src/openscience"
import { FirecrawlSearch } from "../../src/research/firecrawl"
import { SearchFilters } from "../../src/research/search-filters"

const input: ResearchSearchInput = {
  query: "protein research",
  source: "web",
  mode: "balanced",
  content: "snippets",
  limit: 8,
}

async function search(value: Partial<ResearchSearchInput>, data: object) {
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json())
      return Response.json({ success: true, ...data })
    },
  })
  try {
    const result = await FirecrawlSearch.search(
      { ...input, ...value },
      {
        key: "fc-test",
        signal: new AbortController().signal,
        baseURL: server.url.toString(),
      },
    )
    expect(bodies).toHaveLength(1)
    return { result, body: bodies[0] }
  } finally {
    server.stop(true)
  }
}

test("date constraints reach Firecrawl and locally omit wrong or unestablished publication dates", async () => {
  const { result, body } = await search(
    { published_after: "2024-01-01", published_before: "2024-12-31" },
    {
      data: {
        web: [
          { url: "https://example.org/first", date: "2024-01-01" },
          { url: "https://example.org/last", metadata: { "article:published_time": "2024-12-31T23:59:59-08:00" } },
          { url: "https://example.org/old", published_at: "2023-12-31" },
          { url: "https://example.org/new", publishedDate: "2025-01-01" },
          { url: "https://example.org/relative", date: "3 months ago" },
          {
            url: "https://example.org/2024/02/04",
            description: "Published 2024-02-04",
            metadata: { modifiedTime: "2024-02-04" },
          },
          { url: "https://example.org/invalid", date: "2024-02-30" },
        ],
      },
    },
  )
  expect(body.tbs).toBe("cdr:1,cd_min:01/01/2024,cd_max:12/31/2024")
  expect(result.results.map((item) => item.published_at)).toEqual(["2024-01-01", "2024-12-31"])
  expect(result.warnings?.join(" ")).toContain("Omitted 2 results outside")
  expect(result.warnings?.join(" ")).toContain("Omitted 3 results without")
  expect(result.search_details.date_filter).toBe("publication_date_required")
})

test("one-sided bounds are forwarded without inventing the missing date", () => {
  expect(SearchFilters.tbs({ ...input, published_after: "2024-02-29" })).toBe("cdr:1,cd_min:02/29/2024")
  expect(SearchFilters.tbs({ ...input, published_before: "2023-12-31" })).toBe("cdr:1,cd_max:12/31/2023")
  expect(() => SearchFilters.tbs({ ...input, published_after: "2023-02-29" })).toThrow()
  expect(() => SearchFilters.tbs({ ...input, published_after: "2025-01-01", published_before: "2024-01-01" })).toThrow()
})

test("news retains its documented snippet and date and is filtered locally without unsupported tbs", async () => {
  const { result, body } = await search(
    { source: "news", published_after: "2026-08-01" },
    {
      warning: "Some source content is unavailable",
      data: {
        news: [
          { url: "https://news.example/current", snippet: "Actual news snippet", date: "2026-08-30" },
          { url: "https://news.example/old", snippet: "Old", date: "2026-07-31" },
          { url: "https://news.example/relative", snippet: "Relative", date: "2 hours ago" },
        ],
        web: [{ url: "https://example.org/not-news", date: "2026-08-30" }],
      },
    },
  )
  expect(body.sources).toEqual(["news"])
  expect(body.tbs).toBeUndefined()
  expect(result.results).toEqual([
    {
      url: "https://news.example/current",
      description: "Actual news snippet",
      date: "2026-08-30",
      published_at: "2026-08-30",
    },
  ])
  expect(result.warnings).toContain("Firecrawl: Some source content is unavailable")
})

test("relative news dates remain visible when there is no strict date constraint", async () => {
  const { result } = await search(
    { source: "news" },
    { data: { news: [{ url: "https://example.org/news", snippet: "News body", date: "2 hours ago" }] } },
  )
  expect(result.results[0]).toMatchObject({ description: "News body", date: "2 hours ago" })
  expect(result.results[0].published_at).toBeUndefined()
})

for (const source of ["web", "research", "news", "developer"] as const) {
  test(`${source} rejects provider domain leaks, deceptive hosts, and unsafe URLs`, async () => {
    const { result } = await search(
      { source, include_domains: ["python.org"] },
      {
        data: {
          [source === "news" ? "news" : "web"]: [
            { url: "https://docs.python.org/3/errors" },
            { url: "https://python.org/" },
            { url: "https://python.org.evil.test/" },
            { url: "https://evilpython.org/" },
            { url: "https://medium.com/python-errors" },
            { url: "https://user:password@python.org/" },
            { url: "file:///tmp/python.org" },
            { url: "/invalid" },
          ],
        },
      },
    )
    expect(result.results.map((item) => item.url)).toEqual(["https://docs.python.org/3/errors", "https://python.org/"])
    expect(result.search_details.domain_filter).toBe("enforced")
  })
}

test("domain exclusion covers subdomains and trailing-dot hosts without excluding lookalikes", async () => {
  const { result } = await search(
    { exclude_domains: ["example.org"] },
    {
      data: {
        web: [
          { url: "https://example.org./hidden" },
          { url: "https://docs.example.org/no" },
          { url: "https://notexample.org/yes" },
        ],
      },
    },
  )
  expect(result.results.map((item) => item.url)).toEqual(["https://notexample.org/yes"])
})

test("developer groups obey the same constraints and duplicate URLs are removed", async () => {
  const { result, body } = await search(
    { source: "developer", include_domains: ["docs.python.org"] },
    {
      data: {
        web: [{ url: "https://docs.python.org/a" }],
        developer: [
          { url: "https://docs.python.org/a#part" },
          { url: "https://docs.python.org/b" },
          { url: "https://medium.com/python" },
        ],
      },
    },
  )
  expect(body.categories).toEqual([{ type: "developer" }])
  expect(result.results.map((item) => item.url)).toEqual(["https://docs.python.org/a", "https://docs.python.org/b"])
})

for (const mode of ["fast", "balanced", "deep"] as const) {
  for (const content of ["snippets", "top"] as const) {
    test(`${mode}/${content} reports its actual enrichment and limit contract`, async () => {
      const enrich = mode === "deep" || content === "top"
      const { result, body } = await search(
        { mode, content },
        {
          creditsUsed: 3,
          data: {
            web: [
              { url: "https://example.org/one", description: "One", markdown: "# Full content" },
              { url: "https://example.org/two", description: "Two" },
            ],
          },
        },
      )
      expect(body.limit).toBe(enrich ? 3 : 8)
      if (enrich)
        expect(body.scrapeOptions).toMatchObject({
          formats: ["markdown"],
          onlyMainContent: true,
          parsers: [],
          proxy: "basic",
        })
      if (!enrich) expect(body.scrapeOptions).toBeUndefined()
      expect(result.search_details).toMatchObject({
        mode,
        requested_limit: 8,
        effective_limit: enrich ? 3 : 8,
        returned_count: 2,
        content_requested: enrich,
        enriched_count: enrich ? 1 : 0,
        ranking: "provider",
      })
      expect(result.results[0].markdown).toBe(enrich ? "# Full content" : undefined)
      expect(result.provider_credits_used).toBe(3)
      if (enrich) expect(result.warnings?.join(" ")).toContain("entries contain search snippets only")
    })
  }
}

test("provider over-delivery and oversized content stay bounded", async () => {
  const { result } = await search(
    { limit: 2, content: "top" },
    {
      data: {
        web: Array.from({ length: 5 }, (_, index) => ({
          url: `https://example.org/${index}`,
          title: "Title",
          markdown: "A".repeat(40_000),
        })),
      },
    },
  )
  expect(result.results).toHaveLength(2)
  expect(result.results.every((item) => item.content_truncated)).toBe(true)
  expect(result.results.every((item) => item.title === "Title")).toBe(true)
  expect(result.warnings?.join(" ")).toContain("text was truncated")
  expect(
    result.results.reduce((sum, item) => sum + (item.title?.length ?? 0) + (item.markdown?.length ?? 0), 0),
  ).toBeLessThanOrEqual(50_000)
})

test("source URLs cannot bypass the output bound", async () => {
  const { result } = await search(
    {},
    {
      data: {
        web: [
          { url: `https://example.org/${"a".repeat(9000)}`, title: "Oversized" },
          { url: "https://example.org/valid", title: "Valid" },
        ],
      },
    },
  )
  expect(result.results).toEqual([{ url: "https://example.org/valid", title: "Valid" }])
  expect(result.warnings?.join(" ")).toContain("overlong")
})

test("absolute provider date formats reject impossible times without guessing relative ages", () => {
  for (const value of ["2024-02-29", "2024-02-29T12:30", "2024-02-29 12:30:40", "2024-02-29t12:30:40z"]) {
    expect(SearchFilters.publicationDate(value)).toBe("2024-02-29")
  }
  for (const value of [
    "2023-02-29T12:30:00Z",
    "2024-02-29T24:00:00Z",
    "2024-02-29T12:60:00Z",
    "0000-01-01",
    "yesterday",
  ]) {
    expect(SearchFilters.publicationDate(value)).toBeUndefined()
  }
})

test("deadline covers a response that sends headers but never completes its body", async () => {
  const state = { cancelled: false }
  const fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":true,'))
        },
        cancel() {
          state.cancelled = true
        },
      }),
    )) as FirecrawlSearch.Fetch
  await expect(
    FirecrawlSearch.search(input, { key: "fc-test", signal: new AbortController().signal, fetch, timeoutMs: 20 }),
  ).rejects.toThrow("timed out")
  expect(state.cancelled).toBe(true)
})

test("already-cancelled search never dispatches", async () => {
  const calls: string[] = []
  const fetch = (async () => {
    calls.push("POST")
    return Response.json({ success: true })
  }) as FirecrawlSearch.Fetch
  await expect(
    FirecrawlSearch.search(input, { key: "fc-test", signal: AbortSignal.abort(new Error("cancelled")), fetch }),
  ).rejects.toThrow("cancelled")
  expect(calls).toEqual([])
})

test("oversized streaming responses fail once without another paid POST", async () => {
  const calls: string[] = []
  const fetch = (async () => {
    calls.push("POST")
    return new Response("x".repeat(2 * 1024 * 1024 + 1))
  }) as FirecrawlSearch.Fetch
  await expect(
    FirecrawlSearch.search(input, { key: "fc-test", signal: new AbortController().signal, fetch }),
  ).rejects.toThrow("2 MB safety limit")
  expect(calls).toEqual(["POST"])
})

test("redirects cannot forward the saved Firecrawl credential", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname)
      return new Response(null, { status: 302, headers: { Location: "/credential-target" } })
    },
  })
  try {
    await expect(
      FirecrawlSearch.search(input, {
        key: "fc-test",
        signal: new AbortController().signal,
        baseURL: server.url.toString(),
      }),
    ).rejects.toThrow()
    expect(paths).toEqual(["/v2/search"])
  } finally {
    server.stop(true)
  }
})
