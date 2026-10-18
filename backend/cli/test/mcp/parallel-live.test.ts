import { expect, test } from "bun:test"
import { MCP } from "../../src/mcp"
import { ConnectorCatalog } from "../../src/mcp/catalog"
import { Instance } from "../../src/project/instance"
import { tmpdir, trustProject } from "../fixture/fixture"

// Explicit opt-in: this sends public queries and URLs to Parallel, whose
// anonymous endpoint is rate limited. Default test runs remain offline.
test.skipIf(process.env.OPENSCIENCE_LIVE_PARALLEL !== "1")(
  "Parallel's anonymous preset searches and fetches through the MCP caller",
  async () => {
    const preset = ConnectorCatalog.get("parallel-search")!
    expect(preset.setup?.url).toBe("https://search.parallel.ai/mcp")
    expect(preset.setup?.oauth).toBe("off")
    await using tmp = await tmpdir({
      git: true,
      config: {
        mcp: {
          "parallel-search": {
            type: "remote",
            url: preset.setup!.url,
            oauth: false,
            enabled: true,
            timeout: 60_000,
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        try {
          const tools = await MCP.tools()
          const session = crypto.randomUUID()
          const search = tools["parallel-search_web_search"]?.execute
          const fetch = tools["parallel-search_web_fetch"]?.execute
          expect(search).toBeDefined()
          expect(fetch).toBeDefined()
          const found = await search!(
            {
              objective: "Find OpenScience's public documentation for connecting MCP servers.",
              search_queries: ["OpenScience MCP connector documentation"],
              session_id: session,
            },
            { toolCallId: "parallel-search-smoke", messages: [] },
          )
          expect(found).toMatchObject({ isError: false })
          expect(found.content.length).toBeGreaterThan(0)
          const page = await fetch!(
            { urls: ["https://example.com"], session_id: session },
            { toolCallId: "parallel-fetch-smoke", messages: [] },
          )
          expect(page).toMatchObject({ isError: false })
          expect(page.content.length).toBeGreaterThan(0)
        } finally {
          await (await MCP.clients())["parallel-search"]?.close()
        }
      },
    })
  },
  150_000,
)
