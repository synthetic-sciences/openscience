import { expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
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
