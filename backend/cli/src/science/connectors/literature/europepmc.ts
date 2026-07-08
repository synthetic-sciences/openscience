import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { raw, snippet } from "./shared"

/**
 * Europe PMC REST API.
 *
 * A single search endpoint returns rich records (`resultType=core` includes the
 * abstract). Ids are namespaced by source (e.g. "MED/12345678", "PMC/PMC123");
 * fetch resolves them back through the same search endpoint via `ext_id`/`src`.
 */

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"

interface Result {
  id?: string
  source?: string
  pmid?: string
  pmcid?: string
  doi?: string
  title?: string
  authorString?: string
  abstractText?: string
  pubYear?: string
  // `resultType=core` records (this connector hardcodes core) nest the journal
  // name under journalInfo.journal.title. Older/lite shapes put it top-level as
  // journalTitle — keep both so either shape resolves.
  journalTitle?: string
  journalInfo?: { journal?: { title?: string } }
  citedByCount?: number
}

/** The publication venue, from whichever shape the record uses. */
export function journalName(r: Result): string | undefined {
  return r.journalInfo?.journal?.title ?? r.journalTitle
}

interface SearchResponse {
  hitCount?: number
  resultList?: { result?: Result[] }
}

function url(r: Result): string | undefined {
  if (r.source && r.id) return `https://europepmc.org/article/${r.source}/${r.id}`
  if (r.doi) return `https://doi.org/${r.doi}`
  return undefined
}

function toHit(r: Result): ConnectorHit {
  const meta = [r.authorString, journalName(r), r.pubYear].filter(Boolean).join(". ")
  return {
    id: r.source && r.id ? `${r.source}/${r.id}` : (r.id ?? ""),
    title: snippet(r.title, 300) ?? r.id ?? "Untitled",
    summary: snippet(r.abstractText) ?? (meta.length ? meta : undefined),
    url: url(r),
    score: typeof r.citedByCount === "number" ? r.citedByCount : undefined,
    extra: raw(r),
  }
}

export const europepmc: Connector = {
  id: "europepmc",
  name: "Europe PMC",
  domain: "literature",
  description: "Life-science literature and full-text (PubMed, PMC, Agricola, patents) via EBI.",
  homepage: "https://europepmc.org",

  async search(query, opts) {
    const size = Math.min(opts?.limit ?? 10, 50)
    const data = await getJSON<SearchResponse>(
      `${BASE}/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${size}`,
      { signal: opts?.signal },
    )
    return (data.resultList?.result ?? []).map(toHit)
  },

  async fetch(id, opts) {
    const slash = id.indexOf("/")
    const query = slash > 0 ? `ext_id:${id.slice(slash + 1)} AND src:${id.slice(0, slash)}` : id
    const data = await getJSON<SearchResponse>(
      `${BASE}/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=1`,
      { signal: opts?.signal },
    )
    return data.resultList?.result?.[0] ?? null
  },
}
