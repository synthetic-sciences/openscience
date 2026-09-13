import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LiteratureTool } from "../../src/tool/literature"
import { Literature } from "../../src/research/literature"
import { Instance } from "../../src/project/instance"
import { SessionFilesystem } from "../../src/session/filesystem"
import { clearCache, resetRateLimits } from "../../src/science/connectors/http"
import { executionSession } from "../fixture/fixture"
import { tinyPDF } from "./fixtures/tiny-pdf"

const ctx = (sessionID: string) => ({
  sessionID,
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
})

const realFetch = globalThis.fetch
let dir = ""

function route(handler: (url: string) => Response) {
  globalThis.fetch = (async (url: string) => handler(String(url))) as unknown as typeof fetch
}

beforeEach(async () => {
  clearCache()
  resetRateLimits()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "literature-"))
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await fs.rm(dir, { recursive: true, force: true })
})

type Args = Parameters<Awaited<ReturnType<typeof LiteratureTool.init>>["execute"]>[0]

async function run(args: Args, session?: string) {
  return Instance.provide({
    directory: dir,
    fn: async () => {
      const id = session ?? (await executionSession()).id
      const tool = await LiteratureTool.init()
      return { result: await tool.execute(args, ctx(id)), sessionID: id }
    },
  })
}

const OPENALEX = JSON.stringify({
  results: [
    {
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.1000/journal.2024.1",
      display_name: "Sparse Attention for Long Documents",
      publication_year: 2024,
      cited_by_count: 12,
      authorships: [{ author: { display_name: "Ada Lovelace" } }, { author: { display_name: "Alan Turing" } }],
      primary_location: {
        source: { display_name: "NeurIPS" },
        landing_page_url: "https://doi.org/10.1000/journal.2024.1",
      },
      best_oa_location: { pdf_url: "https://proceedings.example.org/sparse.pdf" },
      abstract_inverted_index: { Sparse: [0], attention: [1], scales: [2] },
    },
  ],
})

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`

describe("literature search", () => {
  test("renders citable candidates and the per-source report", async () => {
    route((url) => (url.includes("export.arxiv.org") ? new Response(EMPTY_FEED) : new Response(OPENALEX)))
    const { result } = await run({ action: "search", query: "sparse attention" })
    expect(result.metadata.count).toBe(1)
    expect(result.output).toContain(
      "**Sparse Attention for Long Documents** (2024) — Lovelace, Turing — NeurIPS — cited 12",
    )
    expect(result.output).toContain("doi:10.1000/journal.2024.1")
    expect(result.output).toContain("full text: open")
    expect(result.output).toContain("openalex: 1 · arxiv: 0")
  })

  test("every source down is an explicit unavailable result, not an empty search", async () => {
    route(() => new Response("Rate exceeded", { status: 429 }))
    const { result } = await run({ action: "search", query: "anything" })
    expect(result.metadata.error).toBe("sources_unavailable")
    expect(result.title).toBe("Literature search unavailable")
    expect(result.output).toContain("openalex: rate limited (HTTP 429")
  })

  test("search without a query is rejected", async () => {
    await expect(run({ action: "search" })).rejects.toThrow(/search needs a query/)
  })
})

describe("literature read", () => {
  test("a local PDF is extracted once and served from the cache afterwards", async () => {
    if (!(await Literature.extractor())) return
    const pdf = path.join(dir, "two-pages.pdf")
    await Bun.write(pdf, tinyPDF(["Hello from page one", "Results appear on page two"]))
    const first = await run({ action: "read", ref: pdf })
    expect(first.result.metadata.pages).toBe(2)
    expect(first.result.metadata.cached).toBe(false)
    expect(first.result.output).toContain("[p.1]")
    expect(first.result.output).toContain("Hello from page one")
    expect(first.result.output).toContain("[p.2]")
    const second = await run({ action: "read", ref: pdf, query: "page two" }, first.sessionID)
    expect(second.result.metadata.cached).toBe(true)
    expect(second.result.output).toContain("Showing: 1 passage(s)")
    expect(second.result.output).toContain("[p.2]")
    expect(second.result.output).not.toContain("Hello from page one")
    const workspace = await Instance.provide({
      directory: dir,
      fn: () => SessionFilesystem.workspace(first.sessionID),
    })
    const text = await fs.readFile(
      path.join(workspace, "papers", `${first.result.metadata.text}`.split("/").pop()!),
      "utf8",
    )
    expect(text.split("\f")).toHaveLength(2)
  })

  test("a DOI without an open copy is reported as abstract only", async () => {
    route(
      () =>
        new Response(
          JSON.stringify({
            id: "https://openalex.org/W3",
            doi: "https://doi.org/10.1000/closed.1",
            display_name: "A Closed Access Paper",
            publication_year: 2023,
            authorships: [{ author: { display_name: "Grace Hopper" } }],
            primary_location: {
              source: { display_name: "Nature" },
              landing_page_url: "https://doi.org/10.1000/closed.1",
            },
            abstract_inverted_index: { Closed: [0], but: [1], summarized: [2] },
          }),
        ),
    )
    const { result } = await run({ action: "read", ref: "https://doi.org/10.1000/closed.1" })
    expect(result.metadata.status).toBe("abstract-only")
    expect(result.output).toContain("**A Closed Access Paper** — Hopper — (2023)")
    expect(result.output).toContain("Status: abstract only")
    expect(result.output).toContain("Closed but summarized")
  })

  test("an unrecognized reference explains the accepted forms", async () => {
    await expect(run({ action: "read", ref: "nope" })).rejects.toThrow(/DOI.*arXiv id.*URL.*local PDF path/)
  })
})
