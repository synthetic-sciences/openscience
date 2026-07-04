/**
 * NCBI Gene via Entrez E-utilities — gene records by symbol, name, or keyword.
 * Public, keyless (eutils.ncbi.nlm.nih.gov).
 */
import type { Connector, ConnectorHit } from "../types"
import { esearch, esummary, esummaryOne } from "./eutils"
import { asRecord, str, summarize, type Rec } from "./util"

const DEFAULT_ORGANISM = "Homo sapiens"

function geneHit(rec: Rec): ConnectorHit {
  const uid = str(rec.uid) ?? ""
  const symbol = str(rec.name) ?? str(rec.nomenclaturesymbol) ?? uid
  const organism = str(asRecord(rec.organism).scientificname)
  const chromosome = str(rec.chromosome)
  const locus = str(rec.maplocation) ?? (chromosome ? `chr ${chromosome}` : undefined)
  const aliases = str(rec.otheraliases)
  return {
    id: uid,
    title: symbol,
    summary: summarize([
      str(rec.description) ?? str(rec.nomenclaturename),
      organism ? `organism: ${organism}` : undefined,
      locus ? `locus: ${locus}` : undefined,
      aliases ? `aliases: ${aliases}` : undefined,
    ]),
    url: uid ? `https://www.ncbi.nlm.nih.gov/gene/${uid}` : undefined,
    extra: rec,
  }
}

export const ncbiGene: Connector = {
  id: "ncbi-gene",
  name: "NCBI Gene",
  domain: "genomics",
  description: "Gene records (symbol, aliases, locus, summary) from NCBI Entrez Gene.",
  homepage: "https://www.ncbi.nlm.nih.gov/gene",

  async search(query, opts) {
    const term = query.trim()
    if (term.length === 0) return []
    const retmax = Math.min(opts?.limit ?? 10, 25)
    const organism = str(opts?.organism) ?? DEFAULT_ORGANISM
    const scoped = term.includes("[") ? term : `${term} AND ${organism}[orgn]`
    const ids = await esearch("gene", scoped, retmax, opts?.signal)
    const records = await esummary("gene", ids, opts?.signal)
    return records.map(geneHit).filter((hit) => hit.id.length > 0)
  },

  async fetch(id, opts) {
    return (await esummaryOne("gene", id.trim(), opts?.signal)) ?? {}
  },
}
