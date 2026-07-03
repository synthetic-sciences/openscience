/**
 * PDBe — the Protein Data Bank in Europe (EMBL-EBI).
 *
 * Search API: https://www.ebi.ac.uk/pdbe/search/pdb/select (Solr)
 * Entry API:  https://www.ebi.ac.uk/pdbe/api/pdb/entry/summary/{id}
 *
 * Same underlying archive as RCSB but with EBI's own annotations, summaries,
 * and cross-references.
 */
import type { Connector, ConnectorHit, FetchOptions, SearchOptions } from "../types"
import { getJSON } from "../http"
import { asArray, clampLimit, firstString, toRaw } from "./util"

interface SolrDoc {
  pdb_id?: string
  title?: string
  experimental_method?: string[]
  resolution?: number
  organism_scientific_name?: string[]
}
interface SolrResponse {
  response?: { numFound?: number; docs?: SolrDoc[] }
}

function docSummary(d: SolrDoc): string | undefined {
  const method = asArray<string>(d.experimental_method)[0]
  const parts = [method, typeof d.resolution === "number" ? `${d.resolution} Å` : undefined].filter(Boolean)
  return parts.length ? parts.join(", ") : undefined
}

export const pdbe: Connector = {
  id: "pdbe",
  name: "PDBe",
  domain: "structure",
  description: "Protein Data Bank in Europe — 3D structures with EBI annotations and cross-references.",
  homepage: "https://www.ebi.ac.uk/pdbe",

  async search(query, opts?: SearchOptions): Promise<ConnectorHit[]> {
    const rows = clampLimit(opts?.limit, 10, 25)
    const fl = "pdb_id,title,experimental_method,resolution,organism_scientific_name"
    const url =
      `https://www.ebi.ac.uk/pdbe/search/pdb/select?q=${encodeURIComponent(query)}` +
      `&wt=json&rows=${rows}&fl=${encodeURIComponent(fl)}`
    const data = await getJSON<SolrResponse>(url, { signal: opts?.signal }).catch(() => ({}) as SolrResponse)
    const seen = new Set<string>()
    const hits: ConnectorHit[] = []
    for (const d of asArray<SolrDoc>(data.response?.docs)) {
      const id = d.pdb_id
      if (typeof id !== "string" || seen.has(id)) continue
      seen.add(id)
      hits.push({
        id,
        title: firstString(d.title, id) ?? id,
        summary: docSummary(d),
        url: `https://www.ebi.ac.uk/pdbe/entry/pdb/${id}`,
        extra: toRaw(d),
      })
    }
    return hits
  },

  async fetch(id, opts?: FetchOptions): Promise<unknown> {
    const key = id.toLowerCase()
    const data = await getJSON<Record<string, unknown>>(
      `https://www.ebi.ac.uk/pdbe/api/pdb/entry/summary/${encodeURIComponent(key)}`,
      { signal: opts?.signal },
    ).catch(() => ({}) as Record<string, unknown>)
    // PDBe wraps records as { "<pdbid>": [ {...} ] } — unwrap when present.
    const entry = asArray(data[key])[0]
    return entry ?? data
  },
}
