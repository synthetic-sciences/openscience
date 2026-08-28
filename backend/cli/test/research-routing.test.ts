import { expect, test } from "bun:test"
import { FirecrawlSearch } from "../src/research/firecrawl"
import { ResearchRouting } from "../src/research/routing"

test("research routing spends through managed search for Wallet or reload access", () => {
  expect(ResearchRouting.select({ mode: "managed", aceEnabled: true, managedUnlocked: true, firecrawl: true })).toBe(
    "managed",
  )
  expect(ResearchRouting.select({ mode: "byok", aceEnabled: true, managedUnlocked: true, firecrawl: true })).toBe(
    "firecrawl_byok",
  )
  expect(ResearchRouting.select({ mode: "managed", aceEnabled: false, managedUnlocked: true, firecrawl: true })).toBe(
    "managed",
  )
  expect(ResearchRouting.select({ mode: "managed", aceEnabled: true, managedUnlocked: false, firecrawl: false })).toBe(
    "community",
  )
})

test("Firecrawl BYOK uses the trusted header and returns bounded structured results", async () => {
  const calls: { url?: string; init?: RequestInit } = {}
  const result = await FirecrawlSearch.search(
    {
      query: "protein binder design",
      source: "research",
      mode: "balanced",
      limit: 2,
      content: "top",
      published_after: "2025-01-01",
    },
    {
      key: "fc-test-secret",
      signal: new AbortController().signal,
      baseURL: "https://firecrawl.test/",
      fetch: (async (input, init) => {
        calls.url = String(input)
        calls.init = init
        return Response.json({
          success: true,
          data: {
            web: [
              {
                title: "Result",
                description: "Description",
                url: "https://example.test/paper",
                markdown: "Findings",
              },
            ],
          },
        })
      }) as typeof fetch,
    },
  )

  expect(calls.url).toBe("https://firecrawl.test/v2/search")
  expect(new Headers(calls.init?.headers).get("authorization")).toBe("Bearer fc-test-secret")
  expect(calls.init?.body).not.toContain("fc-test-secret")
  expect(JSON.stringify(result)).not.toContain("fc-test-secret")
  expect(result.provider).toBe("firecrawl_byok")
  expect(result.results).toHaveLength(1)
  expect(result.warnings).toContain(
    "Firecrawl BYOK did not enforce publication-date filters; verify dates in the cited sources.",
  )
})

test("Firecrawl failures never echo provider response bodies", async () => {
  await expect(
    FirecrawlSearch.search(
      { query: "test", source: "web", mode: "fast", limit: 1, content: "snippets" },
      {
        key: "fc-hidden",
        signal: new AbortController().signal,
        fetch: (async () =>
          Response.json({ success: false, error: "fc-hidden" }, { status: 401 })) as unknown as typeof fetch,
      },
    ),
  ).rejects.toThrow("Firecrawl search failed with HTTP 401")
})

test("Firecrawl requests settle when the provider transport never responds", async () => {
  await expect(
    FirecrawlSearch.search(
      { query: "test", source: "web", mode: "fast", limit: 1, content: "snippets" },
      {
        key: "fc-hidden",
        signal: new AbortController().signal,
        timeoutMs: 5,
        fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      },
    ),
  ).rejects.toThrow("Firecrawl search timed out after 1 seconds")
})
