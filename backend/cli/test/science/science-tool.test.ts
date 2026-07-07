import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { ScienceSearchTool } from "../../src/tool/science"
import { Instance } from "../../src/project/instance"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"

// S5: a connector that ERRORS must degrade to a normal, actionable tool result
// (with metadata.error) — never a raw `HTTP 429` string, and never confused with
// a genuine "no results". Driven end-to-end through the real science_search tool.

const PAPER_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>http://arxiv.org/api/x</id>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models...</summary>
    <author><name>Ashish Vaswani</name></author>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`

const ERROR_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>http://arxiv.org/api/errors</id>
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_bad</id>
    <title>Error</title>
    <summary>incorrect id format for bad</summary>
  </entry>
</feed>`

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const projectRoot = path.join(__dirname, "../..")
const realFetch = globalThis.fetch

function stubFetch(handler: () => Response) {
  globalThis.fetch = (async () => handler()) as unknown as typeof fetch
}

async function search(query: string) {
  return Instance.provide({
    directory: projectRoot,
    fn: async () => {
      const tool = await ScienceSearchTool.init()
      return tool.execute({ db: "arxiv", query, limit: 10 }, ctx)
    },
  })
}

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("science_search degradation (arxiv)", () => {
  test("a known paper returns hits, not a degraded result", async () => {
    stubFetch(() => new Response(PAPER_FEED, { status: 200 }))
    const result = await search("attention is all you need")
    expect(result.metadata.count).toBe(1)
    expect(result.metadata.error).toBeUndefined()
    expect(result.output).toContain("Attention Is All You Need")
    expect(result.output).toContain("**pdf**: http://arxiv.org/pdf/1706.03762v7")
  })

  test("sustained 429 degrades to an actionable rate-limited result, not a raw HTTP 429", async () => {
    stubFetch(() => new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }))
    const result = await search("anything")
    expect(result.metadata.error).toBe("rate_limited")
    expect(result.metadata.count).toBe(0)
    expect(result.title).toContain("rate limited")
    expect(result.output).toContain("3s")
    // Not the raw thrown string.
    expect(result.output).not.toMatch(/^HTTP 429/)
  })

  test("a malformed query is a source error, never a hit titled Error", async () => {
    stubFetch(() => new Response(ERROR_FEED, { status: 200 }))
    const result = await search("bad")
    expect(result.metadata.error).toBe("source_error")
    expect(result.metadata.count).toBe(0)
    expect(result.title).toContain("source error")
    expect(result.output).not.toContain("## Error")
  })
})
