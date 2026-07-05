import type { Connector, ConnectorHit, SearchOptions } from "../types"
import { getJSON } from "../http"
import { raw, snippet } from "./shared"

/**
 * bioRxiv / medRxiv preprints via api.biorxiv.org.
 *
 * The public API is retrieval-oriented (by DOI or by date/most-recent window)
 * and offers no full-text search. So:
 *   - a DOI-shaped query resolves the record directly (exact);
 *   - any other query scans the most-recent preprints from both servers and
 *     ranks them by term overlap (title/abstract/authors/category).
 * `fetch` takes a DOI, optionally prefixed with a server ("medrxiv:10.1101/…").
 */

const BASE = "https://api.biorxiv.org/details"
const SERVERS = ["biorxiv", "medrxiv"] as const
type Server = (typeof SERVERS)[number]

interface Paper {
  doi?: string
  title?: string
  authors?: string
  abstract?: string
  category?: string
  date?: string
  version?: string
  server?: string
  published?: string
}

interface Details {
  messages?: { status?: string; count?: number }[]
  collection?: Paper[]
}

function isDoi(q: string): boolean {
  return /^10\.\d{4,9}\//.test(q.trim())
}

function server(id: string): { server: Server; doi: string } {
  const colon = id.indexOf(":")
  if (colon > 0) {
    const s = id.slice(0, colon).toLowerCase()
    if (s === "biorxiv" || s === "medrxiv") return { server: s, doi: id.slice(colon + 1) }
  }
  return { server: "biorxiv", doi: id }
}

function link(p: Paper): string | undefined {
  if (!p.doi) return undefined
  const host = (p.server ?? "biorxiv").toLowerCase() === "medrxiv" ? "medrxiv" : "biorxiv"
  return `https://www.${host}.org/content/${p.doi}v${p.version ?? "1"}`
}

function toHit(p: Paper, score?: number): ConnectorHit {
  const meta = [p.authors, p.category, p.date].filter(Boolean).join(". ")
  return {
    id: `${(p.server ?? "biorxiv").toLowerCase()}:${p.doi ?? ""}`,
    title: snippet(p.title, 300) ?? p.doi ?? "Untitled preprint",
    summary: snippet(p.abstract) ?? (meta.length ? meta : undefined),
    url: link(p),
    score,
    extra: raw(p),
  }
}

async function recent(s: Server, count: number, opts?: SearchOptions): Promise<Paper[]> {
  const data = await getJSON<Details>(`${BASE}/${s}/${count}`, { signal: opts?.signal }).catch(() => ({}) as Details)
  return (data.collection ?? []).map((p) => ({ ...p, server: p.server ?? s }))
}

async function byDoi(s: Server, doi: string, opts?: SearchOptions | undefined): Promise<Paper[]> {
  const data = await getJSON<Details>(`${BASE}/${s}/${doi}`, { signal: opts?.signal }).catch(() => ({}) as Details)
  return (data.collection ?? []).map((p) => ({ ...p, server: p.server ?? s }))
}

export const biorxiv: Connector = {
  id: "biorxiv",
  name: "bioRxiv / medRxiv",
  domain: "literature",
  description: "Biology and health-sciences preprints (bioRxiv + medRxiv) via Cold Spring Harbor.",
  homepage: "https://www.biorxiv.org",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 50)
    const only = String(opts?.params?.server ?? "").toLowerCase()
    const targets = SERVERS.filter((s) => !only || s === only)

    if (isDoi(query)) {
      const found = await Promise.all(targets.map((s) => byDoi(s, query.trim(), opts)))
      return found
        .flat()
        .slice(0, limit)
        .map((p) => toHit(p))
    }

    const pool = Math.min(Number(opts?.params?.pool ?? 100) || 100, 200)
    const batches = await Promise.all(targets.map((s) => recent(s, pool, opts)))
    const papers = batches.flat()
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
    if (terms.length === 0) return papers.slice(0, limit).map((p) => toHit(p))

    return papers
      .map((p) => {
        const hay = `${p.title ?? ""} ${p.abstract ?? ""} ${p.authors ?? ""} ${p.category ?? ""}`.toLowerCase()
        const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
        return { p, score }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => toHit(r.p, r.score))
  },

  async fetch(id, opts) {
    const parsed = server(id)
    const primary = await byDoi(parsed.server, parsed.doi, opts)
    if (primary.length) return primary[primary.length - 1]
    const other: Server = parsed.server === "biorxiv" ? "medrxiv" : "biorxiv"
    const fallback = await byDoi(other, parsed.doi, opts)
    return fallback.length ? fallback[fallback.length - 1] : null
  },
}
