import { expect, test } from "bun:test"
import { ResearchSearch } from "../../src/research/search"
import type { FundingSnapshot, ResearchSearchInput } from "../../src/openscience"

const input: ResearchSearchInput = {
  query: "protein research",
  source: "web",
  mode: "balanced",
  content: "snippets",
  limit: 8,
}
const snapshot: FundingSnapshot = {
  api_key: `thk_${"a".repeat(48)}`,
  user_id: "user-search",
  account: "selected-account",
  organization_id: "11111111-1111-4111-8111-111111111111",
}

test("connected Firecrawl key takes priority without charging the selected Ace account", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls.push(new URL(request.url).pathname)
      expect(request.headers.get("authorization")).toBe("Bearer fc-personal")
      expect(request.headers.has("X-Organization-ID")).toBe(false)
      const body = await request.json()
      expect(body.sources).toEqual(["news"])
      expect(body.limit).toBe(3)
      expect(body.scrapeOptions).toMatchObject({ parsers: [], proxy: "basic" })
      return Response.json({
        success: true,
        creditsUsed: 0,
        data: { news: [{ url: "https://example.test/news", title: "News" }] },
      })
    },
  })
  try {
    const result = await ResearchSearch.search(
      { ...input, source: "news", mode: "deep" },
      {
        key: "fc-personal",
        snapshot,
        signal: new AbortController().signal,
        operationID: "search-personal-key",
        baseURL: server.url.toString(),
      },
    )
    expect(result).toMatchObject({ funding: "byok", provider_credits_used: 0 })
    expect(calls).toEqual(["/v2/search"])
  } finally {
    server.stop(true)
  }
})

test("without a personal key, search uses the selected Ace workspace and durable operation id", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/v1/research/search")
      expect(request.headers.get("authorization")).toBe(`Bearer ${snapshot.api_key}`)
      expect(request.headers.get("X-Organization-ID")).toBe(snapshot.organization_id!)
      expect(request.headers.get("Idempotency-Key")).toBe("stable-search-operation")
      expect(await request.json()).toEqual({ ...input, operation_id: "stable-search-operation" })
      return Response.json(
        {
          operation_id: "stable-search-operation",
          status: "completed",
          provider: "gateway",
          funding: "wallet",
          results: [{ url: "https://example.test/research" }],
          wallet_charge_microusd: 2000,
          search_details: {
            source: "web",
            mode: "balanced",
            requested_limit: 8,
            effective_limit: 8,
            returned_count: 1,
            content_requested: false,
            enriched_count: 0,
            ranking: "provider",
            date_filter: "none",
            domain_filter: "none",
          },
        },
        {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": `organization:${snapshot.organization_id}`,
          },
        },
      )
    },
  })
  try {
    const result = await ResearchSearch.search(input, {
      snapshot,
      operationID: "stable-search-operation",
      signal: new AbortController().signal,
      baseURL: server.url.toString(),
    })
    expect(result).toMatchObject({ funding: "wallet", wallet_charge_microusd: 2000 })
    expect(result?.search_details).toMatchObject({ returned_count: 1, enriched_count: 0, content_requested: false })
  } finally {
    server.stop(true)
  }
})

test("a BYOK failure never retries against Ace", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      calls.push(new URL(request.url).pathname)
      return Response.json({ success: false }, { status: 401 })
    },
  })
  try {
    await expect(
      ResearchSearch.search(input, {
        key: "fc-invalid",
        snapshot,
        operationID: "no-funding-fallback",
        signal: new AbortController().signal,
        baseURL: server.url.toString(),
      }),
    ).rejects.toThrow("HTTP 401")
    expect(calls).toEqual(["/v2/search"])
  } finally {
    server.stop(true)
  }
})

test("managed search rejects a response funded by another workspace", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(
        { status: "completed" },
        {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": "personal",
          },
        },
      )
    },
  })
  try {
    await expect(
      ResearchSearch.search(input, {
        snapshot,
        operationID: "wrong-workspace",
        signal: new AbortController().signal,
        baseURL: server.url.toString(),
      }),
    ).rejects.toThrow("selected workspace")
  } finally {
    server.stop(true)
  }
})

test("no key and no signed-in account never dispatches a paid request", async () => {
  expect(
    await ResearchSearch.search(input, { operationID: "signed-out-search", signal: new AbortController().signal }),
  ).toBeUndefined()
})
