import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { arxiv } from "../../src/science/connectors/literature/arxiv"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"

// arXiv returns Atom XML parsed with regex helpers. The two historical traps:
//   1. the PDF <link/> is self-closing, so the paired-block parser never saw it;
//   2. a malformed query yields an HTTP 200 error <entry> that used to surface
//      as a bogus hit titled "Error".
// These fixtures mirror the real API shape (self-closing links, error entry).

// A normal single-result feed. Note the PDF link is SELF-CLOSING and its `title`
// attribute precedes `href` — extraction must not depend on attribute order.
const PAPER_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query=all:attention" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=all:attention</title>
  <id>http://arxiv.org/api/abc</id>
  <updated>2017-06-13T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks that include an encoder and a decoder.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.5555/3295222.3295349</arxiv:doi>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`

// arXiv's HTTP 200 error response for a malformed id/query.
const ERROR_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/errors" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=&amp;id_list=1234.error</title>
  <id>http://arxiv.org/api/errors</id>
  <updated>2024-01-01T00:00:00-05:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_1234.error</id>
    <title>Error</title>
    <summary>incorrect id format for 1234.error</summary>
    <updated>2024-01-01T00:00:00-05:00</updated>
    <link href="http://arxiv.org/api/errors#incorrect_id_format_for_1234.error" rel="alternate" type="text/html"/>
    <author><name>arXiv api core</name></author>
  </entry>
</feed>`

// A genuine zero-result feed (valid Atom, no <entry>).
const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query=all:zzznoresults" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=all:zzznoresults</title>
  <id>http://arxiv.org/api/empty</id>
  <updated>2024-01-01T00:00:00-05:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:itemsPerPage>
</feed>`

const realFetch = globalThis.fetch

/** Stub fetch with a fixed body and capture the requested URL. */
function stub(body: string, status = 200): { url: () => string } {
  let seen = ""
  globalThis.fetch = (async (url: string) => {
    seen = String(url)
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { url: () => seen }
}

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("arxiv.parse (via search)", () => {
  test("extracts the self-closing PDF link", async () => {
    stub(PAPER_FEED)
    const hits = await arxiv.search("attention is all you need")
    expect(hits).toHaveLength(1)
    // The whole point: pdf used to be ALWAYS undefined.
    expect(hits[0].extra?.pdf).toBe("http://arxiv.org/pdf/1706.03762v7")
  })

  test("parses core metadata (id, title, authors, category)", async () => {
    stub(PAPER_FEED)
    const [hit] = await arxiv.search("attention")
    expect(hit.id).toBe("1706.03762v7")
    expect(hit.title).toBe("Attention Is All You Need")
    expect(hit.url).toBe("http://arxiv.org/abs/1706.03762v7")
    expect(hit.extra?.primaryCategory).toBe("cs.CL")
    expect(hit.extra?.authors).toEqual(["Ashish Vaswani", "Noam Shazeer"])
  })

  test("a zero-result feed returns [] (not an error)", async () => {
    stub(EMPTY_FEED)
    expect(await arxiv.search("zzznoresults")).toEqual([])
  })
})

describe("arxiv error handling", () => {
  test("an arXiv error entry is never returned as a hit", async () => {
    stub(ERROR_FEED)
    // Surfaced as a source error, not a bogus hit titled "Error".
    await expect(arxiv.search("1234.error")).rejects.toThrow(/arXiv rejected the query/)
  })

  test("fetch() rejects an error entry too", async () => {
    stub(ERROR_FEED)
    await expect(arxiv.fetch("1234.error")).rejects.toThrow(/arXiv rejected the query/)
  })

  test("a non-Atom (HTML/empty) body is a typed error, not []", async () => {
    stub("<html><body>503 Service Temporarily Unavailable</body></html>")
    await expect(arxiv.search("anything")).rejects.toThrow(/non-Atom|HTML page/)
  })
})

describe("arxiv query fielding", () => {
  test("passes a fielded query through unwrapped", async () => {
    const s = stub(EMPTY_FEED)
    await arxiv.search("ti:transformer AND cat:cs.LG")
    expect(s.url()).toContain(`search_query=${encodeURIComponent("ti:transformer AND cat:cs.LG")}`)
    expect(s.url()).not.toContain(encodeURIComponent("all:ti:"))
  })

  test("wraps a bare query in all:", async () => {
    const s = stub(EMPTY_FEED)
    await arxiv.search("graph neural networks")
    expect(s.url()).toContain(`search_query=${encodeURIComponent("all:graph neural networks")}`)
  })
})
