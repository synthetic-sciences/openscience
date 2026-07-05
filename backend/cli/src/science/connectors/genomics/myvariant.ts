/**
 * MyVariant.info — aggregated variant annotation (dbSNP, ClinVar, CADD, dbNSFP…).
 * Public, keyless (myvariant.info/v1). Variant ids are HGVS, e.g. "chr1:g.35367G>A".
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { arr, asRecord, num, str, summarize, type Rec } from "./util"

const BASE = "https://myvariant.info/v1"

interface QueryEnvelope {
  hits?: unknown
}

/** cadd.gene may be a single object or an array; pull the first gene name. */
function geneName(cadd: Rec): string | undefined {
  const gene = cadd["gene"]
  const direct = str(asRecord(gene).genename)
  if (direct) return direct
  return str(asRecord(arr(gene)[0]).genename)
}

function rsidOf(rec: Rec): string | undefined {
  return str(asRecord(rec.dbsnp).rsid) ?? str(asRecord(rec.clinvar).rsid)
}

function variantHit(rec: Rec): ConnectorHit {
  const id = str(rec._id) ?? ""
  const cadd = asRecord(rec.cadd)
  const rsid = rsidOf(rec)
  return {
    id,
    title: id,
    summary: summarize([
      rsid ? `rsID: ${rsid}` : undefined,
      geneName(cadd) ? `gene: ${geneName(cadd)}` : undefined,
      str(cadd.consequence) ? `consequence: ${str(cadd.consequence)}` : undefined,
    ]),
    url: rsid
      ? `https://www.ncbi.nlm.nih.gov/snp/${rsid}`
      : `https://myvariant.info/v1/variant/${encodeURIComponent(id)}`,
    score: num(rec._score),
    extra: rec,
  }
}

export const myvariant: Connector = {
  id: "myvariant",
  name: "MyVariant.info",
  domain: "genomics",
  description: "Aggregated variant annotation (dbSNP, ClinVar, CADD, dbNSFP) by HGVS or rsID.",
  homepage: "https://myvariant.info",

  async search(query, opts) {
    const term = query.trim()
    if (term.length === 0) return []
    const size = Math.min(opts?.limit ?? 10, 25)
    const data = await getJSON<QueryEnvelope>(`${BASE}/query?q=${encodeURIComponent(term)}&size=${size}`, {
      signal: opts?.signal,
    })
    return arr(data.hits)
      .map((hit) => variantHit(hit as Rec))
      .filter((hit) => hit.id.length > 0)
  },

  async fetch(id, opts) {
    return getJSON<Rec>(`${BASE}/variant/${encodeURIComponent(id.trim())}`, { signal: opts?.signal })
  },
}
