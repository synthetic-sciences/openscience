import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { arxiv, arxivApiCooldown } from "../../src/science/connectors/literature/arxiv"
import { clearCache, HttpStatusError, resetRateLimits } from "../../src/science/connectors/http"

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

// OpenAlex's record for the same paper (abstract arrives as an inverted index).
const OPENALEX_WORK = JSON.stringify({
  id: "https://openalex.org/W2963403868",
  doi: "https://doi.org/10.48550/arxiv.1706.03762",
  display_name: "Attention Is All You Need",
  publication_date: "2017-06-12",
  cited_by_count: 100000,
  abstract_inverted_index: { The: [0], dominant: [1], models: [2] },
  authorships: [{ author: { display_name: "Ashish Vaswani" } }, { author: { display_name: "Noam Shazeer" } }],
})

const OPENALEX_SEARCH = JSON.stringify({
  results: [
    JSON.parse(OPENALEX_WORK),
    {
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.1000/journal.1",
      display_name: "Not an arXiv paper",
      locations: [{ landing_page_url: "https://example.org/paper" }],
    },
    {
      id: "https://openalex.org/W2",
      display_name: "Found by location",
      primary_location: { landing_page_url: "https://arxiv.org/abs/2401.00001v2" },
    },
  ],
})

const ABS_PAGE = `<!DOCTYPE html><html><head>
<meta name="citation_title" content="Attention Is All You Need" />
<meta name="citation_author" content="Vaswani, Ashish" />
<meta name="citation_author" content="Shazeer, Noam" />
<meta name="citation_date" content="2017/06/12" />
<meta name="citation_doi" content="10.5555/3295222.3295349" />
<meta name="citation_pdf_url" content="https://arxiv.org/pdf/1706.03762" />
<meta name="citation_abstract" content="The dominant sequence transduction models &amp; friends." />
</head><body><span class="primary-subject">Computation and Language (cs.CL)</span></body></html>`

/** Route stub: pick a response by URL host/path; record every URL requested. */
function route(handler: (url: string) => Response): { urls: string[] } {
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url))
    return handler(String(url))
  }) as unknown as typeof fetch
  return { urls }
}

const limited = () => new Response("Rate exceeded", { status: 429 })

describe("arxiv fallbacks when the API is rate limited", () => {
  test("fetch answers from OpenAlex and marks the record `via`", async () => {
    const seen = route((url) => (url.includes("export.arxiv.org") ? limited() : new Response(OPENALEX_WORK)))
    const record = (await arxiv.fetch("1706.03762v7")) as Record<string, unknown>
    expect(record.title).toBe("Attention Is All You Need")
    expect(record.via).toBe("openalex")
    expect(record.summary).toBe("The dominant models")
    expect(record.pdf).toBe("https://arxiv.org/pdf/1706.03762")
    expect(seen.urls.some((u) => u.includes("api.openalex.org/works/doi:10.48550/arXiv.1706.03762"))).toBe(true)
    // One 429 starts the cooldown so the next call does not touch the API at all.
    expect(arxivApiCooldown()).toBeGreaterThan(0)
  })

  test("a cooling-down API is skipped entirely, including its 3 s pacing", async () => {
    const first = route((url) => (url.includes("export.arxiv.org") ? limited() : new Response(OPENALEX_WORK)))
    await arxiv.fetch("1706.03762")
    const apiCalls = first.urls.filter((u) => u.includes("export.arxiv.org")).length
    expect(apiCalls).toBe(1) // a single attempt, then the cooldown starts
    const second = route((url) => (url.includes("export.arxiv.org") ? limited() : new Response(OPENALEX_WORK)))
    const started = Date.now()
    await arxiv.fetch("2401.00001")
    expect(second.urls.filter((u) => u.includes("export.arxiv.org"))).toHaveLength(0)
    expect(Date.now() - started).toBeLessThan(2500)
  })

  test("OpenAlex lag falls through to the abs page; a 404 there is a genuine miss", async () => {
    route((url) => {
      if (url.includes("export.arxiv.org")) return limited()
      if (url.includes("api.openalex.org")) return new Response("{}", { status: 404 })
      return new Response(ABS_PAGE, { headers: { "content-type": "text/html" } })
    })
    const record = (await arxiv.fetch("1706.03762")) as Record<string, unknown>
    expect(record.via).toBe("arxiv.org/abs")
    expect(record.title).toBe("Attention Is All You Need")
    expect(record.authors).toEqual(["Vaswani, Ashish", "Shazeer, Noam"])
    expect(record.summary).toBe("The dominant sequence transduction models & friends.")
    expect(record.primaryCategory).toBe("cs.CL")
    expect(record.published).toBe("2017-06-12")

    resetRateLimits()
    route((url) => (url.includes("export.arxiv.org") ? limited() : new Response("not here", { status: 404 })))
    expect(await arxiv.fetch("9999.99999")).toBeNull()
  })

  test("search answers from OpenAlex restricted to arXiv-indexed works and keeps arXiv ids", async () => {
    const seen = route((url) => (url.includes("export.arxiv.org") ? limited() : new Response(OPENALEX_SEARCH)))
    const hits = await arxiv.search("ti:attention AND cat:cs.CL")
    const openalex = seen.urls.find((u) => u.includes("api.openalex.org"))!
    expect(openalex).toContain("filter=indexed_in:arxiv")
    expect(openalex).toContain("search=attention&")
    // Works without an arXiv id are dropped; ids come from the DOI or a location URL.
    expect(hits.map((h) => h.id)).toEqual(["1706.03762", "2401.00001v2"])
    expect(hits[0].extra?.via).toBe("openalex")
    expect(hits[0].extra?.pdf).toBe("https://arxiv.org/pdf/1706.03762")
  })

  test("when every route fails the error keeps the API status and lists what was tried", async () => {
    route(() => limited())
    const error = await arxiv.fetch("1706.03762").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpStatusError)
    const status = error as HttpStatusError
    expect(status.status).toBe(429)
    expect(status.url).toContain("export.arxiv.org")
    expect(status.attempts).toBe(1)
    expect(status.message).toContain("OpenAlex")
    expect(status.message).toContain("arxiv.org/abs")
  })

  test("a rejected query never falls back: arXiv is the authority on its own syntax", async () => {
    const seen = route((url) =>
      url.includes("export.arxiv.org") ? new Response(ERROR_FEED) : new Response(OPENALEX_WORK),
    )
    await expect(arxiv.fetch("1234.error")).rejects.toThrow(/arXiv rejected the query/)
    expect(seen.urls.some((u) => u.includes("openalex"))).toBe(false)
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
