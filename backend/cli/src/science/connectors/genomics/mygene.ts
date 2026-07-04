/**
 * MyGene.info — fast gene annotation query hub across many species.
 * Public, keyless (mygene.info/v3).
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { arr, num, str, summarize, type Rec } from "./util"

const BASE = "https://mygene.info/v3"

interface QueryEnvelope {
  hits?: unknown
}

function geneHit(rec: Rec): ConnectorHit {
  const id = str(rec._id) ?? ""
  const symbol = str(rec.symbol) ?? id
  const entrez = str(rec.entrezgene)
  const taxid = str(rec.taxid)
  return {
    id,
    title: symbol,
    summary: summarize([
      str(rec.name),
      entrez ? `entrez: ${entrez}` : undefined,
      taxid ? `taxid: ${taxid}` : undefined,
    ]),
    url: entrez
      ? `https://www.ncbi.nlm.nih.gov/gene/${entrez}`
      : `https://mygene.info/v3/gene/${encodeURIComponent(id)}`,
    score: num(rec._score),
    extra: rec,
  }
}

export const mygene: Connector = {
  id: "mygene",
  name: "MyGene.info",
  domain: "genomics",
  description: "Gene annotation lookup (symbol, name, Entrez/Ensembl ids) across species.",
  homepage: "https://mygene.info",

  async search(query, opts) {
    const term = query.trim()
    if (term.length === 0) return []
    const size = Math.min(opts?.limit ?? 10, 25)
    const species = str(opts?.organism) ?? "human"
    const data = await getJSON<QueryEnvelope>(
      `${BASE}/query?q=${encodeURIComponent(term)}&size=${size}&species=${encodeURIComponent(species)}`,
      { signal: opts?.signal },
    )
    return arr(data.hits)
      .map((hit) => geneHit(hit as Rec))
      .filter((hit) => hit.id.length > 0)
  },

  async fetch(id, opts) {
    return getJSON<Rec>(`${BASE}/gene/${encodeURIComponent(id.trim())}`, { signal: opts?.signal })
  },
}
