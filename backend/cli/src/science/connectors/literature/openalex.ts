import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { fromInverted, raw, snippet } from "./shared"

/**
 * OpenAlex — open catalog of ~250M works, authors, venues, and concepts.
 *
 * Abstracts arrive as an `abstract_inverted_index` (word → positions) and are
 * reconstructed to plain text. `mailto` uses OpenAlex's polite pool (faster,
 * higher limits); an optional key enables the premium pool. Both come from
 * settings ▸ Credentials → "OpenAlex" (OPENALEX_MAILTO / OPENALEX_API_KEY) and
 * fall back to the project contact so unauthenticated installs still work.
 */

const BASE = "https://api.openalex.org/works"

// Read at call time so credentials saved mid-session apply without a restart.
function politeParams(): string {
  const email = process.env.OPENALEX_MAILTO?.trim() || "support@syntheticsciences.ai"
  const parts = [`mailto=${encodeURIComponent(email)}`]
  const key = process.env.OPENALEX_API_KEY?.trim()
  if (key) parts.push(`api_key=${encodeURIComponent(key)}`)
  return parts.join("&")
}

interface Authorship {
  author?: { display_name?: string }
}

interface Location {
  source?: { display_name?: string }
  landing_page_url?: string
}

interface Work {
  id?: string
  doi?: string
  title?: string
  display_name?: string
  publication_year?: number
  cited_by_count?: number
  abstract_inverted_index?: Record<string, number[]> | null
  authorships?: Authorship[]
  primary_location?: Location
  relevance_score?: number
}

interface SearchResponse {
  results?: Work[]
  meta?: { count?: number }
}

function shortId(id?: string): string {
  return (id ?? "").replace(/^https?:\/\/openalex\.org\//i, "")
}

function authors(w: Work): string | undefined {
  const names = (w.authorships ?? []).map((a) => a.author?.display_name).filter((n): n is string => !!n)
  if (names.length === 0) return undefined
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} et al.` : names.join(", ")
}

function toHit(w: Work): ConnectorHit {
  const meta = [authors(w), w.primary_location?.source?.display_name, w.publication_year].filter(Boolean).join(". ")
  return {
    id: shortId(w.id) || (w.doi ?? ""),
    title: snippet(w.display_name ?? w.title, 300) ?? (shortId(w.id) || "Untitled"),
    summary: snippet(fromInverted(w.abstract_inverted_index)) ?? (meta.length ? meta : undefined),
    url: w.id ?? w.primary_location?.landing_page_url ?? w.doi ?? undefined,
    score: typeof w.relevance_score === "number" ? w.relevance_score : w.cited_by_count,
    extra: raw(w),
  }
}

export const openalex: Connector = {
  id: "openalex",
  name: "OpenAlex",
  domain: "literature",
  description: "Open scholarly graph of works, authors, venues, and concepts (successor to MAG).",
  homepage: "https://openalex.org",

  async search(query, opts) {
    const per = Math.min(opts?.limit ?? 10, 50)
    const data = await getJSON<SearchResponse>(
      `${BASE}?search=${encodeURIComponent(query)}&per-page=${per}&${politeParams()}`,
      { signal: opts?.signal },
    )
    return (data.results ?? []).map(toHit)
  },

  async fetch(id, opts) {
    // OpenAlex accepts a bare work id (W…), or a DOI as a raw path segment
    // ("works/doi:10.x/y"); the DOI's slash/colon must stay unencoded.
    const path = /^10\.\d/.test(id) ? `doi:${id}` : encodeURIComponent(shortId(id) || id)
    const data = await getJSON<Work>(`${BASE}/${path}?${politeParams()}`, { signal: opts?.signal })
    return data ?? null
  },
}
