import type { Connector, ConnectorHit } from "../types"
import { getText } from "../http"
import { raw, snippet, xmlAttr, xmlBlocks, xmlText } from "./shared"

/**
 * arXiv via its Atom query API (export.arxiv.org/api).
 *
 * The API returns Atom XML, not JSON, so entries are parsed with the small
 * regex helpers in ./shared. `fetch` uses the `id_list` form for exact lookup.
 */

const BASE = "https://export.arxiv.org/api/query"

interface Entry {
  id: string
  title?: string
  summary?: string
  published?: string
  updated?: string
  authors: string[]
  doi?: string
  primaryCategory?: string
  pdf?: string
  raw: string
}

function bareId(idUrl: string): string {
  return idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//i, "").trim()
}

function parse(xml: string): Entry[] {
  return xmlBlocks(xml, "entry").map((block) => {
    const id = xmlText(block, "id") ?? ""
    const authors = xmlBlocks(block, "author")
      .map((a) => xmlText(a, "name"))
      .filter((n): n is string => !!n)
    const pdf = xmlBlocks(block, "link").find((l) => /title="pdf"/i.test(l))
    return {
      id,
      title: xmlText(block, "title"),
      summary: xmlText(block, "summary"),
      published: xmlText(block, "published"),
      updated: xmlText(block, "updated"),
      authors,
      doi: xmlText(block, "arxiv:doi"),
      primaryCategory: xmlAttr(block, "arxiv:primary_category", "term"),
      pdf: pdf ? (/href="([^"]+)"/.exec(pdf)?.[1] ?? undefined) : undefined,
      raw: block,
    }
  })
}

function toHit(e: Entry): ConnectorHit {
  const id = bareId(e.id)
  const who = e.authors.length > 4 ? `${e.authors.slice(0, 4).join(", ")} et al.` : e.authors.join(", ")
  const meta = [who, e.primaryCategory, e.published?.slice(0, 10)].filter(Boolean).join(". ")
  return {
    id,
    title: snippet(e.title, 300) ?? id,
    summary: snippet(e.summary) ?? (meta.length ? meta : undefined),
    url: e.id || `https://arxiv.org/abs/${id}`,
    extra: raw(e),
  }
}

export const arxiv: Connector = {
  id: "arxiv",
  name: "arXiv",
  domain: "literature",
  description: "Open-access preprints in physics, math, CS, quantitative biology, and more.",
  homepage: "https://arxiv.org",

  async search(query, opts) {
    const max = Math.min(opts?.limit ?? 10, 50)
    const xml = await getText(
      `${BASE}?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${max}&sortBy=relevance`,
      { signal: opts?.signal },
    )
    return parse(xml).map(toHit)
  },

  async fetch(id, opts) {
    const clean = bareId(id)
    const xml = await getText(`${BASE}?id_list=${encodeURIComponent(clean)}&max_results=1`, {
      signal: opts?.signal,
    })
    return parse(xml)[0] ?? null
  },
}
