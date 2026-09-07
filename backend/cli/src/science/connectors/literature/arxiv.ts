import type { Connector, ConnectorHit } from "../types"
import { getText } from "../http"
import { raw, snippet, xmlAttr, xmlBlocks, xmlSelfClosing, xmlText } from "./shared"

/**
 * arXiv via its Atom query API (export.arxiv.org/api).
 *
 * The API returns Atom XML, not JSON, so entries are parsed with the small
 * regex helpers in ./shared. `fetch` uses the `id_list` form for exact lookup.
 */

const BASE = "https://export.arxiv.org/api/query"

// arXiv asks for ≤ 1 request every 3s from a single client. Applied per-host so
// other literature sources fanning out in parallel are unaffected.
const RATE_LIMIT = { minIntervalMs: 3000 }

// Query prefixes arXiv understands. When the caller already fields their query
// (e.g. `ti:transformer AND cat:cs.LG`) we pass it through instead of wrapping
// the whole thing in `all:`, which would break the field syntax.
const FIELDED = /^(ti|au|abs|co|jr|cat|rn|id|all):/i

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

/** A genuine Atom feed opens with `<feed …>`; HTML error pages / empty bodies don't. */
function isAtomFeed(xml: string): boolean {
  return /<feed[\s>]/i.test(xml)
}

/**
 * arXiv answers a malformed query/id with HTTP 200 and a single `<entry>` whose
 * id points at `…/api/errors` and whose title is literally "Error". Those are
 * not results — surface them as an error instead of a bogus hit.
 */
function isErrorEntry(e: Entry): boolean {
  return e.id.startsWith("http://arxiv.org/api/errors") || e.title === "Error"
}

/** Wrap a bare query in `all:`; leave an already-fielded query untouched. */
function searchExpr(query: string): string {
  const q = query.trim()
  return FIELDED.test(q) ? q : `all:${q}`
}

function parse(xml: string): Entry[] {
  return xmlBlocks(xml, "entry").map((block) => {
    const id = xmlText(block, "id") ?? ""
    const authors = xmlBlocks(block, "author")
      .map((a) => xmlText(a, "name"))
      .filter((n): n is string => !!n)
    // arXiv's PDF link is self-closing: `<link title="pdf" href="…" …/>`. It has
    // no `</link>` close tag, so the paired-block helpers can't see it.
    const pdf = xmlSelfClosing(block, "link").find((l) => (l.attrs.title ?? "").toLowerCase() === "pdf")?.attrs.href
    return {
      id,
      title: xmlText(block, "title"),
      summary: xmlText(block, "summary"),
      published: xmlText(block, "published"),
      updated: xmlText(block, "updated"),
      authors,
      doi: xmlText(block, "arxiv:doi"),
      primaryCategory: xmlAttr(block, "arxiv:primary_category", "term"),
      pdf,
      raw: block,
    }
  })
}

/**
 * Fetch + validate one arXiv Atom response. Throws (rather than returning `[]`)
 * for non-Atom bodies and for arXiv's error entries, so the tool layer can tell
 * a source error apart from a genuine zero-result query.
 */
async function feed(url: string, signal?: AbortSignal): Promise<Entry[]> {
  const xml = await getText(url, { signal, rateLimit: RATE_LIMIT, looksValid: isAtomFeed })
  if (!isAtomFeed(xml)) {
    throw new Error("arXiv returned a non-Atom response (likely rate-limited or unavailable); retry shortly.")
  }
  const entries = parse(xml)
  const bad = entries.find(isErrorEntry)
  if (bad) throw new Error(`arXiv rejected the query: ${bad.summary ?? bad.title ?? "malformed request"}`)
  return entries
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
  description:
    "Preprint metadata and abstracts in physics, math, CS, quantitative biology, and more. Paper text must be retrieved separately from the returned PDF link.",
  homepage: "https://arxiv.org",

  async search(query, opts) {
    const max = Math.min(opts?.limit ?? 10, 50)
    const url = `${BASE}?search_query=${encodeURIComponent(searchExpr(query))}&start=0&max_results=${max}&sortBy=relevance`
    const entries = await feed(url, opts?.signal)
    return entries.map(toHit)
  },

  async fetch(id, opts) {
    const clean = bareId(id)
    const entries = await feed(`${BASE}?id_list=${encodeURIComponent(clean)}&max_results=1`, opts?.signal)
    return entries[0] ?? null
  },
}
