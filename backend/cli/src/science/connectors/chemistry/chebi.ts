import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

/**
 * ChEBI — Chemical Entities of Biological Interest (EMBL-EBI), queried through
 * the EBI Ontology Lookup Service v4 (OLS4) REST/JSON API. No key required.
 *   search: GET /ols4/api/search?q=<query>&ontology=chebi&rows=<n>
 *   fetch:  GET /ols4/api/ontologies/chebi/terms?obo_id=<CHEBI:id>
 */
const OLS = "https://www.ebi.ac.uk/ols4/api"

interface Doc {
  obo_id?: string
  short_form?: string
  label?: string
  description?: string[]
  exact_synonyms?: string[]
  [key: string]: unknown
}

export const chebi: Connector = {
  id: "chebi",
  name: "ChEBI",
  domain: "chemistry",
  description: "Chemical Entities of Biological Interest ontology terms (EMBL-EBI).",
  homepage: "https://www.ebi.ac.uk/chebi",

  async search(query, opts) {
    const rows = Math.min(opts?.limit ?? 10, 25)
    const url = `${OLS}/search?q=${encodeURIComponent(query)}&ontology=chebi&rows=${rows}`
    const data = await getJSON<{ response?: { docs?: Doc[] } }>(url, { signal: opts?.signal }).catch(
      () => ({}) as { response?: { docs?: Doc[] } },
    )
    const docs = data.response?.docs ?? []
    return docs.slice(0, rows).map<ConnectorHit>((d) => {
      const id = d.obo_id ?? d.short_form?.replace("_", ":") ?? ""
      return {
        id,
        title: d.label ?? id ?? "(unnamed entity)",
        summary: d.description?.[0] ?? d.exact_synonyms?.join(", "),
        url: id ? `https://www.ebi.ac.uk/chebi/searchId.do?chebiId=${encodeURIComponent(id)}` : undefined,
        extra: d,
      }
    })
  },

  async fetch(id, opts) {
    const url = `${OLS}/ontologies/chebi/terms?obo_id=${encodeURIComponent(id)}`
    const data = await getJSON<{ _embedded?: { terms?: unknown[] } }>(url, { signal: opts?.signal }).catch(
      () => ({}) as { _embedded?: { terms?: unknown[] } },
    )
    const terms = data._embedded?.terms
    return Array.isArray(terms) && terms.length ? terms[0] : data
  },
}
