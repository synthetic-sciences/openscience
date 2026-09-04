import { expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { SecretBox } from "../../src/util/secret-box"
import { SecretFile } from "../../src/util/secret-file"
import { ResearchSearchTool } from "../../src/tool/research-search"
import { Truncate } from "../../src/tool/truncation"
import { SearchDedupe } from "../../src/session/search-dedupe"

for (const body of ["科学证据🧬".repeat(12_000), 'line\n"quoted"\\tab\t'.repeat(5000)]) {
  test(`research_search keeps large ${body.startsWith("科学") ? "Unicode" : "escaped"} page content valid through the final tool boundary`, async () => {
    const store = path.join(Global.Path.data, "credentials.json")
    const key = await SecretFile.key(path.join(Global.Path.data, "credentials.key"))
    await Bun.write(
      store,
      JSON.stringify({
        firecrawl: {
          source: "local",
          fields: { api_key: SecretBox.seal(key, "fc-test-output") },
          updated_at: new Date().toISOString(),
        },
      }),
    )
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          success: true,
          creditsUsed: 3,
          data: { web: [{ url: "https://example.org/paper", title: "Paper", markdown: body }] },
        })
      },
    })
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        expect(String(url)).toBe("https://api.firecrawl.dev/v2/search")
        calls.push(String(url))
        return original(new URL("/v2/search", server.url), options)
      },
      { preconnect: original.preconnect },
    )
    try {
      const tool = await ResearchSearchTool.init()
      const result = await tool.execute(
        { query: "protein research", source: "web", mode: "deep", content: "top", limit: 3 },
        {
          sessionID: "search_output_fixture",
          messageID: "msg_search_output",
          callID: "call_search_output",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      const parsed = JSON.parse(result.output)
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(Truncate.MAX_BYTES)
      expect(result.output.split("\n").length).toBeLessThanOrEqual(Truncate.MAX_LINES)
      expect(parsed).toMatchObject({
        funding: "byok",
        provider_credits_used: 3,
        search_details: { returned_count: 1, enriched_count: 1 },
      })
      expect(parsed.results[0]).toMatchObject({ url: "https://example.org/paper", content_truncated: true })
      expect(parsed.warnings.length).toBeGreaterThan(0)
      const cached = SearchDedupe.reuse({
        id: "part_output_fixture",
        sessionID: "search_output_fixture",
        messageID: "msg_search_output",
        type: "tool",
        callID: "call_search_output",
        tool: "research_search",
        state: {
          status: "completed",
          input: { query: "protein research", source: "web", mode: "deep", content: "top", limit: 3 },
          output: result.output,
          title: result.title,
          metadata: result.metadata,
          time: { start: 1, end: 2 },
        },
      })
      expect(Buffer.byteLength(cached.output, "utf8")).toBeLessThanOrEqual(Truncate.MAX_BYTES)
      expect(JSON.parse(cached.output)).toMatchObject({ funding: "byok", provider_credits_used: 3 })
      expect(cached.metadata.dedupeHit).toBe(true)
      expect(calls).toHaveLength(1)
    } finally {
      globalThis.fetch = original
      server.stop(true)
      await Bun.write(store, "{}")
    }
  })
}

test("research_search exposes the hosted empty free fallback as a typed partial provider outcome", async () => {
  const store = path.join(Global.Path.data, "credentials.json")
  const prior = await OpenScience.getSession()
  await Bun.write(store, "{}")
  await OpenScience.saveSession({
    api_key: "osk_fixture_search_fallback",
    user_id: "user_search_fallback",
    organization_id: "org_search_fallback",
    workspace_locked: true,
  })
  const routes: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      routes.push(url.pathname)
      const headers = {
        "OpenScience-Funding-Protocol": "1",
        "OpenScience-Funding-Context": "organization:org_search_fallback",
      }
      if (url.pathname === "/api/v1/auth/status")
        return Response.json(
          {
            user: { user_id: "user_search_fallback" },
            api_key: { organization_id: "org_search_fallback", workspace_locked: true },
            funding_context: {
              type: "organization",
              organization_id: "org_search_fallback",
              locked: true,
            },
            organizations: [
              {
                organization_id: "org_search_fallback",
                name: "Search fixture",
                status: "active",
                membership_status: "active",
                funding_available: true,
                effective_permissions: ["use_shared_wallet"],
              },
            ],
          },
          { headers },
        )
      expect(url.pathname).toBe("/api/v1/research/search")
      const body = (await request.json()) as { operation_id: string }
      return Response.json(
        {
          operation_id: body.operation_id,
          status: "completed",
          provider: "free_search",
          funding: "free_fallback",
          results: [],
          warnings: ["managed_search_wallet_unavailable", "free_search_fallback", "search_content_unavailable"],
          wallet_charge_microusd: 0,
          provider_usage_pending: false,
          search_details: {
            source: "web",
            mode: "balanced",
            requested_limit: 8,
            effective_limit: 8,
            returned_count: 0,
            content_requested: false,
            enriched_count: 0,
            ranking: "provider",
            date_filter: "none",
            domain_filter: "none",
          },
        },
        { headers },
      )
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      const source = new URL(String(input))
      return original(new URL(`${source.pathname}${source.search}`, server.url), options)
    },
    { preconnect: original.preconnect },
  )
  try {
    const tool = await ResearchSearchTool.init()
    expect(tool.description).toContain("partial provider failure")
    expect(tool.description).toContain("not as evidence of zero matches or blocked network access")
    const result = await tool.execute(
      { query: "protein research", source: "web", mode: "balanced", content: "snippets", limit: 8 },
      {
        sessionID: "search_fallback_fixture",
        messageID: "msg_search_fallback",
        callID: "call_search_fallback",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      },
    )
    expect(JSON.parse(result.output)).toMatchObject({
      status: "partial",
      type: "search_unavailable",
      funding: "free_fallback",
      results: [],
      wallet_charge_microusd: 0,
      provider_usage_pending: false,
    })
    expect(result).toMatchObject({
      title: "Research search unavailable",
      metadata: {
        creditState: "free_fallback",
        outcome: "partial",
        stopReason: "search_unavailable",
        resultCount: 0,
        truncated: false,
      },
    })
    // A workspace-scoped session no longer reconciles account status before a
    // managed search; the gateway still validates the funding echo on the reply.
    expect(routes).toEqual(["/api/v1/research/search"])
  } finally {
    globalThis.fetch = original
    server.stop(true)
    await OpenScience.clearSession()
    if (prior) await OpenScience.saveSession(prior)
    await Bun.write(store, "{}")
  }
})
