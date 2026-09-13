import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import os from "node:os"
import { Literature } from "../../src/research/literature"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { tinyPDF } from "./fixtures/tiny-pdf"

const realFetch = globalThis.fetch

function route(handler: (url: string) => Response): { urls: string[] } {
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url))
    return handler(String(url))
  }) as unknown as typeof fetch
  return { urls }
}

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const work = (input: Record<string, unknown>) => ({
  authorships: [{ author: { display_name: "Ada Lovelace" } }, { author: { display_name: "Alan Turing" } }],
  publication_year: 2024,
  publication_date: "2024-03-01",
  cited_by_count: 12,
  ...input,
})

const OPENALEX = JSON.stringify({
  results: [
    work({
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.1000/journal.2024.1",
      display_name: "Sparse Attention for Long Documents",
      primary_location: {
        source: { display_name: "NeurIPS" },
        landing_page_url: "https://doi.org/10.1000/journal.2024.1",
      },
      best_oa_location: { pdf_url: "https://proceedings.example.org/sparse.pdf" },
      abstract_inverted_index: { Sparse: [0], attention: [1], scales: [2] },
    }),
    work({
      id: "https://openalex.org/W2",
      doi: "https://doi.org/10.48550/arxiv.2401.00002",
      display_name: "Dense Retrieval Revisited",
      locations: [{ landing_page_url: "https://arxiv.org/abs/2401.00002v1" }],
    }),
    work({
      id: "https://openalex.org/W3",
      doi: "https://doi.org/10.1000/closed.1",
      display_name: "A Closed Access Paper",
      primary_location: { source: { display_name: "Nature" }, landing_page_url: "https://doi.org/10.1000/closed.1" },
    }),
  ],
})

const ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>Dense Retrieval Revisited</title>
    <summary>We revisit dense retrieval with a longer abstract than OpenAlex has.</summary>
    <author><name>Ada Lovelace</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2401.00002v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.IR" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.00003v2</id>
    <published>2024-02-03T00:00:00Z</published>
    <title>Only On arXiv</title>
    <summary>A preprint OpenAlex has not indexed yet.</summary>
    <author><name>Grace Hopper</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2402.00003v2" rel="related" type="application/pdf"/>
  </entry>
</feed>`

describe("Literature.parseReference", () => {
  test("classifies arXiv ids, DOIs, URLs and titles", async () => {
    expect(await Literature.parseReference("2401.00002v3")).toEqual({ kind: "arxiv", id: "2401.00002" })
    expect(await Literature.parseReference("arXiv:2401.00002")).toEqual({ kind: "arxiv", id: "2401.00002" })
    expect(await Literature.parseReference("https://arxiv.org/pdf/2401.00002v1")).toEqual({
      kind: "arxiv",
      id: "2401.00002",
    })
    expect(await Literature.parseReference("hep-th/9901001")).toEqual({ kind: "arxiv", id: "hep-th/9901001" })
    expect(await Literature.parseReference("https://doi.org/10.1000/Journal.2024.1")).toEqual({
      kind: "doi",
      doi: "10.1000/journal.2024.1",
    })
    // The arXiv DOI namespace is an arXiv reference in disguise.
    expect(await Literature.parseReference("10.48550/arXiv.2401.00002")).toEqual({ kind: "arxiv", id: "2401.00002" })
    expect(await Literature.parseReference("https://example.org/paper.pdf")).toEqual({
      kind: "url",
      url: "https://example.org/paper.pdf",
    })
    expect(await Literature.parseReference("Sparse Attention for Long Documents")).toEqual({
      kind: "title",
      title: "Sparse Attention for Long Documents",
    })
    await expect(Literature.parseReference("nope")).rejects.toThrow(/Unrecognized reference/)
  })

  test("a local file wins when it exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lit-"))
    const file = path.join(dir, "paper.pdf")
    await Bun.write(file, "%PDF-1.4\n")
    expect(await Literature.parseReference("paper.pdf", dir)).toEqual({ kind: "file", path: file })
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("Literature.search", () => {
  test("merges the same paper across sources and ranks agreement first", async () => {
    route((url) => (url.includes("export.arxiv.org") ? new Response(ARXIV) : new Response(OPENALEX)))
    const result = await Literature.search("dense retrieval", { limit: 10 })
    const titles = result.candidates.map((c) => c.title)
    // Found by both sources (arXiv id from the DOI, then the Atom feed).
    expect(titles[0]).toBe("Dense Retrieval Revisited")
    const merged = result.candidates[0]
    expect(merged.sources.toSorted()).toEqual(["arxiv", "openalex"])
    expect(merged.arxiv).toBe("2401.00002")
    expect(merged.pdf).toBe("https://arxiv.org/pdf/2401.00002")
    // The longer abstract survives the merge.
    expect(merged.abstract).toContain("longer abstract")
    expect(result.candidates).toHaveLength(4)
    expect(result.sources).toEqual([
      { source: "openalex", count: 3, error: undefined, via: undefined },
      { source: "arxiv", count: 2, error: undefined, via: undefined },
    ])
    const closed = result.candidates.find((c) => c.title === "A Closed Access Paper")!
    expect(closed.pdf).toBeUndefined()
    expect(closed.doi).toBe("10.1000/closed.1")
    const open = result.candidates.find((c) => c.title === "Sparse Attention for Long Documents")!
    expect(open.pdf).toBe("https://proceedings.example.org/sparse.pdf")
    expect(open.venue).toBe("NeurIPS")
  })

  test("a failing source is reported and the rest of the search still answers", async () => {
    route((url) => {
      if (url.includes("export.arxiv.org") || url.includes("indexed_in"))
        return new Response("Rate exceeded", { status: 429 })
      return new Response(OPENALEX)
    })
    const result = await Literature.search("dense retrieval")
    expect(result.candidates.map((c) => c.title)).toContain("Sparse Attention for Long Documents")
    const arxiv = result.sources.find((s) => s.source === "arxiv")!
    expect(arxiv.count).toBe(0)
    expect(arxiv.error).toMatch(/rate limited \(HTTP 429/)
    expect(result.sources.find((s) => s.source === "openalex")!.count).toBe(3)
  })

  test("year filters reach OpenAlex and prune undated-safe candidates", async () => {
    const seen = route((url) => (url.includes("export.arxiv.org") ? new Response(ARXIV) : new Response(OPENALEX)))
    const result = await Literature.search("retrieval", { since: 2025 })
    const openalex = seen.urls.find((u) => u.includes("api.openalex.org"))!
    expect(openalex).toContain("from_publication_date:2025-01-01")
    // Every fixture is dated 2024, so nothing survives the client-side check either.
    expect(result.candidates).toHaveLength(0)
  })
})

describe("Literature text helpers", () => {
  const pages = [
    "Abstract. We study multi-head attention in transformers. Introduction follows.",
    "Section 2 describes the method. Multi-head attention uses several heads in parallel.",
    "Section 3 reports results on translation. Nothing about attention here.",
  ]

  test("passages find the phrase with page numbers and skip pages without it", () => {
    const found = Literature.passages(pages, "multi-head attention", { width: 60 })
    expect(found.map((f) => f.page)).toEqual([1, 2])
    expect(found[0].text).toContain("multi-head attention")
  })

  test("passages fall back to all terms in a window when the phrase is absent", () => {
    const found = Literature.passages(pages, "results translation", { width: 200 })
    expect(found.map((f) => f.page)).toEqual([3])
  })

  test("pageRange and head clip to the budget and label pages", () => {
    const range = Literature.pageRange(pages, "2-3", 10_000)
    expect(range.text.startsWith("[p.2]")).toBe(true)
    expect(range.text).toContain("[p.3]")
    expect(range.truncated).toBe(false)
    const short = Literature.head(pages, 60)
    expect(short.truncated).toBe(true)
    expect(short.text).toContain("[p.1]")
    expect(() => Literature.pageRange(pages, "9", 100)).toThrow(/3 pages/)
    expect(() => Literature.pageRange(pages, "x", 100)).toThrow(/pages must look like/)
  })
})

describe("Literature.extract", () => {
  test("produces one entry per page when an extractor is installed", async () => {
    const tool = await Literature.extractor()
    if (!tool) return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lit-pdf-"))
    const file = path.join(dir, "two-pages.pdf")
    await Bun.write(file, tinyPDF(["Hello from page one", "Results appear on page two"]))
    const extracted = await Literature.extract(file)
    expect(extracted?.tool).toBe(tool)
    expect(extracted?.pages).toHaveLength(2)
    expect(extracted?.pages[0]).toContain("Hello from page one")
    expect(extracted?.pages[1]).toContain("Results appear on page two")
    await fs.rm(dir, { recursive: true, force: true })
  })
})
