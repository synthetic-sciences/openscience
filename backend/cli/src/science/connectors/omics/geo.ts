/**
 * NCBI GEO (Gene Expression Omnibus) connector.
 *
 * Backed by the public NCBI E-utilities REST API over the `gds` (GEO DataSets)
 * database — the same entrez interface used elsewhere in the codebase. No API
 * key required (rate-limited to ~3 req/s for anonymous callers).
 *
 * search()  → esearch + esummary over db=gds, returns Series/DataSet records.
 * fetch(id) → resolves a GEO accession (GSE/GDS/GPL/GSM) or numeric UID to its
 *             full esummary record.
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

interface ESearchResult {
  esearchresult?: {
    count?: string
    idlist?: string[]
  }
}

interface GeoSummary {
  uid?: string
  accession?: string
  title?: string
  summary?: string
  taxon?: string
  gdstype?: string
  entrytype?: string
  gpl?: string
  gse?: string
  n_samples?: number
  pdat?: string
}

interface ESummaryResult {
  result?: Record<string, GeoSummary> & { uids?: string[] }
}

/** Canonical GEO accession URL for a record. */
function geoUrl(accession: string): string {
  return `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${encodeURIComponent(accession)}`
}

function toHit(uid: string, s: GeoSummary | undefined): ConnectorHit {
  const accession = s?.accession && s.accession.length > 0 ? s.accession : uid
  const parts = [s?.taxon, s?.gdstype, s?.pdat].filter((x): x is string => Boolean(x))
  return {
    id: accession,
    title: s?.title ?? accession,
    summary: s?.summary ? s.summary.slice(0, 400) : parts.join(" · ") || undefined,
    url: geoUrl(accession),
    extra: { uid, ...(s ?? {}) },
  }
}

async function summaries(ids: string[], signal?: AbortSignal): Promise<ESummaryResult> {
  if (ids.length === 0) return {}
  return getJSON<ESummaryResult>(`${EUTILS}/esummary.fcgi?db=gds&id=${ids.join(",")}&retmode=json`, { signal })
}

export const geo: Connector = {
  id: "geo",
  name: "NCBI GEO",
  domain: "genomics",
  description: "Gene Expression Omnibus — functional genomics Series, DataSets, and platforms.",
  homepage: "https://www.ncbi.nlm.nih.gov/geo/",

  async search(query, opts) {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const search = await getJSON<ESearchResult>(
      `${EUTILS}/esearch.fcgi?db=gds&term=${encodeURIComponent(query)}&retmode=json&retmax=${limit}`,
      { signal: opts?.signal },
    ).catch(() => ({}) as ESearchResult)
    const ids = search.esearchresult?.idlist ?? []
    if (ids.length === 0) return []
    const summ = await summaries(ids, opts?.signal).catch(() => ({}) as ESummaryResult)
    return ids.map((uid) => toHit(uid, summ.result?.[uid]))
  },

  async fetch(id, opts) {
    const trimmed = id.trim()
    const isUid = /^\d+$/.test(trimmed)
    let uid = trimmed
    if (!isUid) {
      const search = await getJSON<ESearchResult>(
        `${EUTILS}/esearch.fcgi?db=gds&term=${encodeURIComponent(trimmed)}[ACCN]&retmode=json&retmax=20`,
        { signal: opts?.signal },
      ).catch(() => ({}) as ESearchResult)
      const ids = search.esearchresult?.idlist ?? []
      if (ids.length === 0) return { id: trimmed, found: false }
      const summ = await summaries(ids, opts?.signal).catch(() => ({}) as ESummaryResult)
      const match = ids.find((u) => summ.result?.[u]?.accession === trimmed)
      if (match) return summ.result?.[match] ?? { id: trimmed, uid: match }
      uid = ids[0]
    }
    const summ = await summaries([uid], opts?.signal)
    return summ.result?.[uid] ?? { id: trimmed, uid, found: false }
  },
}
