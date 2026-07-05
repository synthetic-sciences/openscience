import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { raw, snippet } from "./shared"

/**
 * Crossref REST API — DOI metadata for ~150M scholarly works.
 *
 * `mailto` opts the requests into Crossref's "polite pool" (no key required).
 * Abstracts, when present, are JATS XML and are stripped to plain text.
 */

const BASE = "https://api.crossref.org/works"
const MAILTO = "mailto=support@syntheticsciences.ai"

interface Author {
  given?: string
  family?: string
  name?: string
}

interface Work {
  DOI?: string
  title?: string[]
  subtitle?: string[]
  abstract?: string
  author?: Author[]
  "container-title"?: string[]
  publisher?: string
  type?: string
  URL?: string
  score?: number
  "is-referenced-by-count"?: number
  issued?: { "date-parts"?: number[][] }
}

interface SearchResponse {
  message?: { items?: Work[]; "total-results"?: number }
}

interface WorkResponse {
  message?: Work
}

function year(w: Work): number | undefined {
  return w.issued?.["date-parts"]?.[0]?.[0]
}

function authors(w: Work): string | undefined {
  const names = (w.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean)
  if (names.length === 0) return undefined
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} et al.` : names.join(", ")
}

function toHit(w: Work): ConnectorHit {
  const meta = [authors(w), w["container-title"]?.[0], year(w)].filter(Boolean).join(". ")
  return {
    id: w.DOI ?? "",
    title: snippet([w.title?.[0], w.subtitle?.[0]].filter(Boolean).join(": "), 300) ?? w.DOI ?? "Untitled",
    summary: snippet(w.abstract) ?? (meta.length ? meta : undefined),
    url: w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : undefined),
    score: typeof w.score === "number" ? w.score : undefined,
    extra: raw(w),
  }
}

export const crossref: Connector = {
  id: "crossref",
  name: "Crossref",
  domain: "literature",
  description: "Cross-publisher DOI metadata: titles, authors, venues, references, and citations.",
  homepage: "https://www.crossref.org",

  async search(query, opts) {
    const rows = Math.min(opts?.limit ?? 10, 50)
    const data = await getJSON<SearchResponse>(
      `${BASE}?query=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,subtitle,abstract,author,container-title,publisher,type,URL,score,is-referenced-by-count,issued&${MAILTO}`,
      { signal: opts?.signal },
    )
    return (data.message?.items ?? []).map(toHit)
  },

  async fetch(id, opts) {
    const doi = id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim()
    const data = await getJSON<WorkResponse>(`${BASE}/${encodeURIComponent(doi)}?${MAILTO}`, {
      signal: opts?.signal,
    })
    return data.message ?? null
  },
}
