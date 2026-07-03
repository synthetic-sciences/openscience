import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { asText, clampLimit, snippet } from "./util"

/** A resolved identifier from STRING's `get_string_ids` endpoint. */
interface StringMatch {
  queryItem?: string
  queryIndex?: number
  stringId?: string
  preferredName?: string
  ncbiTaxonId?: number
  taxonName?: string
  annotation?: string
}

/** A single interaction partner row from `interaction_partners`. */
interface StringPartner {
  stringId_A?: string
  stringId_B?: string
  preferredName_A?: string
  preferredName_B?: string
  ncbiTaxonId?: number
  score?: number
}

const API = "https://string-db.org/api"

/**
 * STRING — known and predicted protein-protein interaction networks.
 * Open, no key. STRING is species-scoped; defaults to human (taxon 9606),
 * override via `opts.organism` (an NCBI taxon id such as "10090").
 */
export const stringdb: Connector = {
  id: "string-db",
  name: "STRING",
  domain: "proteomics",
  description: "Known and predicted protein-protein interaction networks.",
  homepage: "https://string-db.org",

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 25)
    const species = asText(opts?.organism) ?? "9606"
    const params = new URLSearchParams({
      identifiers: query,
      species,
      limit: String(limit),
      echo_query: "1",
    })
    const url = `${API}/json/get_string_ids?${params.toString()}`
    const data = await getJSON<StringMatch[]>(url, { signal: opts?.signal }).catch(() => [])
    const rows = Array.isArray(data) ? data : []

    return rows.slice(0, limit).map<ConnectorHit>((m) => {
      const id = m.stringId ?? m.preferredName ?? m.queryItem ?? query
      return {
        id,
        title: m.preferredName ?? id,
        summary: snippet(m.annotation) ?? m.taxonName,
        url: `https://string-db.org/network/${encodeURIComponent(id)}`,
        extra: { ...m },
      }
    })
  },

  async fetch(id, opts) {
    const species = asText(opts?.params?.["species"])
    const params = new URLSearchParams({ identifiers: id, limit: "25" })
    if (species) params.set("species", species)
    const url = `${API}/json/interaction_partners?${params.toString()}`
    const partners = await getJSON<StringPartner[]>(url, { signal: opts?.signal }).catch(() => [])
    return { id, partners: Array.isArray(partners) ? partners : [] }
  },
}
