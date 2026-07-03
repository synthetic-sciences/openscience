/**
 * RCSB PDB — the US Protein Data Bank archive of 3D macromolecular structures.
 *
 * Search API:  https://search.rcsb.org/rcsbsearch/v2/query (full-text query DSL)
 * Data API:    https://data.rcsb.org/rest/v1/core/entry/{id}
 *
 * The search service returns only identifiers + scores, so each hit is enriched
 * (best-effort, in parallel) with a title and experimental metadata from the
 * data API. Enrichment failures degrade gracefully to the bare identifier.
 */
import type { Connector, ConnectorHit, FetchOptions, SearchOptions } from "../types"
import { getJSON } from "../http"
import { asArray, clampLimit, firstString, toRaw } from "./util"

interface SearchResult {
  identifier?: string
  score?: number
}
interface SearchResponse {
  total_count?: number
  result_set?: SearchResult[]
}
interface EntryCore {
  struct?: { title?: string }
  rcsb_entry_info?: {
    experimental_method?: string
    resolution_combined?: number[]
  }
}

const DATA_ENTRY = "https://data.rcsb.org/rest/v1/core/entry"

async function enrich(id: string, signal?: AbortSignal): Promise<ConnectorHit> {
  const base: ConnectorHit = {
    id,
    title: id,
    url: `https://www.rcsb.org/structure/${id}`,
  }
  try {
    const e = await getJSON<EntryCore>(`${DATA_ENTRY}/${encodeURIComponent(id)}`, { signal })
    const info = e.rcsb_entry_info
    const res = info?.resolution_combined?.[0]
    const parts = [info?.experimental_method, res ? `${res} Å` : undefined].filter(Boolean)
    return {
      ...base,
      title: firstString(e.struct?.title, id) ?? id,
      summary: parts.length ? parts.join(", ") : undefined,
      extra: toRaw(e),
    }
  } catch {
    return base
  }
}

export const rcsbPdb: Connector = {
  id: "rcsb-pdb",
  name: "RCSB PDB",
  domain: "structure",
  description: "Experimentally determined 3D structures of proteins, nucleic acids, and complexes.",
  homepage: "https://www.rcsb.org",

  async search(query, opts?: SearchOptions): Promise<ConnectorHit[]> {
    const rows = clampLimit(opts?.limit, 10, 25)
    const payload = {
      query: { type: "terminal", service: "full_text", parameters: { value: query } },
      return_type: "entry",
      request_options: { paginate: { start: 0, rows } },
    }
    const url = `https://search.rcsb.org/rcsbsearch/v2/query?json=${encodeURIComponent(JSON.stringify(payload))}`
    const data = await getJSON<SearchResponse>(url, { signal: opts?.signal }).catch(() => ({}) as SearchResponse)
    const hits = asArray<SearchResult>(data.result_set).filter((r) => typeof r.identifier === "string")
    const enriched = await Promise.all(
      hits.map(async (r) => {
        const hit = await enrich(r.identifier as string, opts?.signal)
        return { ...hit, score: r.score }
      }),
    )
    return enriched
  },

  async fetch(id, opts?: FetchOptions): Promise<unknown> {
    return getJSON(`${DATA_ENTRY}/${encodeURIComponent(id)}`, { signal: opts?.signal })
  },
}
