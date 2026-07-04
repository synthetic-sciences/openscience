import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { asText, clampLimit, snippet, stripTags } from "./util"

/** A single entry inside a Reactome search result group. */
interface ReactomeEntry {
  id?: string
  stId?: string
  dbId?: number | string
  name?: string
  exactType?: string
  species?: string[]
  summation?: string
}

interface ReactomeSearch {
  results?: Array<{ typeName?: string; entries?: ReactomeEntry[] }>
}

const CONTENT = "https://reactome.org/ContentService"

/**
 * Reactome ContentService — curated, peer-reviewed human pathways, reactions,
 * and molecular events. Fully open, no key required.
 */
export const reactome: Connector = {
  id: "reactome",
  name: "Reactome",
  domain: "biology",
  description: "Curated biological pathways, reactions, and molecular events.",
  homepage: "https://reactome.org",

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 25)
    const params = new URLSearchParams({ query, cluster: "true" })
    const species = asText(opts?.organism)
    if (species) params.set("species", species)
    const url = `${CONTENT}/search/query?${params.toString()}`
    const data = await getJSON<ReactomeSearch>(url, { signal: opts?.signal }).catch(() => ({}) as ReactomeSearch)

    const hits: ConnectorHit[] = []
    for (const group of data.results ?? []) {
      for (const entry of group.entries ?? []) {
        const id = entry.stId ?? entry.id ?? (entry.dbId != null ? String(entry.dbId) : undefined)
        if (!id) continue
        hits.push({
          id,
          title: stripTags(entry.name) || id,
          summary: snippet(stripTags(entry.summation)) ?? entry.exactType,
          url: `https://reactome.org/content/detail/${encodeURIComponent(id)}`,
          extra: { ...entry, typeName: group.typeName },
        })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  },

  async fetch(id, opts) {
    const url = `${CONTENT}/data/query/${encodeURIComponent(id)}`
    return getJSON(url, { signal: opts?.signal }).catch(() => null)
  },
}
