import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { raw, snippet } from "./shared"

/**
 * Semantic Scholar Academic Graph API.
 *
 * Key-free tier (rate-limited; the shared http helper backs off on 429). Ids
 * may be a Semantic Scholar paperId or an external id such as "DOI:10.…",
 * "ARXIV:2101.00001", "PMID:12345678", "CorpusId:12345".
 */

const BASE = "https://api.semanticscholar.org/graph/v1/paper"
const FIELDS = "title,abstract,url,year,venue,citationCount,externalIds,authors.name"

// Optional Semantic Scholar API key — set in settings ▸ Credentials → "Literature
// access" (injected as SEMANTIC_SCHOLAR_API_KEY by the credential store). It lifts
// the shared, key-free 429 rate limit. Read at call time so a key saved
// mid-session applies without restarting the server.
function apiHeaders(): Record<string, string> | undefined {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()
  return key ? { "x-api-key": key } : undefined
}

interface Author {
  name?: string
}

interface Paper {
  paperId?: string
  title?: string
  abstract?: string
  url?: string
  year?: number
  venue?: string
  citationCount?: number
  authors?: Author[]
  externalIds?: Record<string, unknown>
}

interface SearchResponse {
  total?: number
  data?: Paper[]
}

function authors(p: Paper): string | undefined {
  const names = (p.authors ?? []).map((a) => a.name).filter((n): n is string => !!n)
  if (names.length === 0) return undefined
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} et al.` : names.join(", ")
}

function toHit(p: Paper): ConnectorHit {
  const meta = [authors(p), p.venue, p.year].filter(Boolean).join(". ")
  return {
    id: p.paperId ?? "",
    title: snippet(p.title, 300) ?? p.paperId ?? "Untitled",
    summary: snippet(p.abstract) ?? (meta.length ? meta : undefined),
    url: p.url ?? (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : undefined),
    score: typeof p.citationCount === "number" ? p.citationCount : undefined,
    extra: raw(p),
  }
}

export const semanticScholar: Connector = {
  id: "semantic-scholar",
  name: "Semantic Scholar",
  domain: "literature",
  description: "AI-powered academic graph: abstracts, citations, references, and influence.",
  homepage: "https://www.semanticscholar.org",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 50)
    const data = await getJSON<SearchResponse>(
      `${BASE}/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${FIELDS}`,
      { signal: opts?.signal, headers: apiHeaders() },
    )
    return (data.data ?? []).map(toHit)
  },

  async fetch(id, opts) {
    // Ids (paperId hex, or "DOI:10.x/y", "ARXIV:…") are passed as a raw path
    // segment — the colon/slash in external ids must not be percent-encoded.
    const data = await getJSON<Paper>(`${BASE}/${id.trim()}?fields=${FIELDS},references.title,citations.title`, {
      signal: opts?.signal,
      headers: apiHeaders(),
    })
    return data ?? null
  },
}
