import type { Connector, ConnectorHit } from "../types"
import { getJSON, getText } from "../http"
import { raw, snippet } from "./shared"

/**
 * PubMed via NCBI E-utilities.
 *
 * Search is two hops: ESearch (query → PMID list) then ESummary (PMIDs →
 * citation metadata). Fetch adds the abstract text via EFetch. All endpoints
 * are public and key-free (the shared http helper handles polite rate limits).
 */

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

interface ESearch {
  esearchresult?: { idlist?: string[]; count?: string }
}

interface Author {
  name?: string
}

interface Summary {
  uid?: string
  title?: string
  fulljournalname?: string
  source?: string
  pubdate?: string
  authors?: Author[]
  elocationid?: string
  volume?: string
  issue?: string
  pages?: string
}

interface ESummary {
  result?: Record<string, Summary | string[]> & { uids?: string[] }
}

function citation(s: Summary): string | undefined {
  const authors = (s.authors ?? [])
    .map((a) => a.name)
    .filter(Boolean)
    .slice(0, 3)
  const lead = authors.length ? `${authors.join(", ")}${(s.authors?.length ?? 0) > 3 ? " et al." : ""}. ` : ""
  const venue = [s.fulljournalname ?? s.source, s.pubdate].filter(Boolean).join(", ")
  const out = `${lead}${venue}`.trim()
  return out.length ? out : undefined
}

export const pubmed: Connector = {
  id: "pubmed",
  name: "PubMed",
  domain: "literature",
  description: "Biomedical literature abstracts and citations from NCBI (MEDLINE/PubMed).",
  homepage: "https://pubmed.ncbi.nlm.nih.gov",

  async search(query, opts) {
    const size = Math.min(opts?.limit ?? 10, 50)
    const esearch = await getJSON<ESearch>(
      `${BASE}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${size}&term=${encodeURIComponent(query)}`,
      { signal: opts?.signal },
    )
    const ids = esearch.esearchresult?.idlist ?? []
    if (ids.length === 0) return []

    const esummary = await getJSON<ESummary>(`${BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`, {
      signal: opts?.signal,
    })
    const result = esummary.result ?? {}
    return ids
      .map((id) => result[id])
      .filter((s): s is Summary => !!s && !Array.isArray(s))
      .map<ConnectorHit>((s) => ({
        id: s.uid ?? "",
        title: snippet(s.title, 300) ?? `PMID ${s.uid}`,
        summary: citation(s),
        url: `https://pubmed.ncbi.nlm.nih.gov/${s.uid}/`,
        extra: raw(s),
      }))
  },

  async fetch(id, opts) {
    const clean = id.replace(/[^0-9]/g, "")
    const esummary = await getJSON<ESummary>(`${BASE}/esummary.fcgi?db=pubmed&retmode=json&id=${clean}`, {
      signal: opts?.signal,
    })
    const record = esummary.result?.[clean]
    const summary = record && !Array.isArray(record) ? record : undefined

    const abstract = await getText(`${BASE}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${clean}`, {
      signal: opts?.signal,
    }).catch(() => undefined)

    return {
      pmid: clean,
      url: `https://pubmed.ncbi.nlm.nih.gov/${clean}/`,
      summary,
      abstract: abstract?.trim() || undefined,
    }
  },
}
