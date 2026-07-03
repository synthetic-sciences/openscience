/**
 * NCBI dbSNP via Entrez E-utilities — reference SNP (rs) records.
 * Public, keyless (eutils.ncbi.nlm.nih.gov, db=snp).
 */
import type { Connector, ConnectorHit } from "../types"
import { esearch, esummary, esummaryOne } from "./eutils"
import { arr, asRecord, str, summarize, type Rec } from "./util"

function geneNames(rec: Rec): string[] {
  return arr(rec.genes)
    .map((g) => str(asRecord(g).name))
    .filter((name): name is string => typeof name === "string")
}

function snpHit(rec: Rec): ConnectorHit {
  const snpId = str(rec.snp_id)
  const id = snpId ?? str(rec.uid) ?? ""
  const rsid = id ? `rs${id}` : ""
  const genes = geneNames(rec)
  const position = str(rec.chrpos)
  const chromosome = str(rec.chr)
  return {
    id,
    title: rsid,
    summary: summarize([
      genes.length > 0 ? `gene: ${genes.join(", ")}` : undefined,
      position ? `pos: ${position}` : chromosome ? `chr: ${chromosome}` : undefined,
      str(rec.fxn_class) ? `class: ${str(rec.fxn_class)}` : undefined,
      str(rec.snp_class) ? `variant: ${str(rec.snp_class)}` : undefined,
      str(rec.clinical_significance) ? `clinical: ${str(rec.clinical_significance)}` : undefined,
    ]),
    url: snpId ? `https://www.ncbi.nlm.nih.gov/snp/rs${snpId}` : undefined,
    extra: rec,
  }
}

export const dbsnp: Connector = {
  id: "dbsnp",
  name: "NCBI dbSNP",
  domain: "genomics",
  description: "Reference SNP (rsID) records: alleles, position, function class, and clinical significance.",
  homepage: "https://www.ncbi.nlm.nih.gov/snp",

  async search(query, opts) {
    const term = query.trim()
    if (term.length === 0) return []
    const retmax = Math.min(opts?.limit ?? 10, 25)
    const ids = await esearch("snp", term, retmax, opts?.signal)
    const records = await esummary("snp", ids, opts?.signal)
    return records.map(snpHit).filter((hit) => hit.id.length > 0)
  },

  async fetch(id, opts) {
    const clean = id.trim().replace(/^rs/i, "")
    return (await esummaryOne("snp", clean, opts?.signal)) ?? {}
  },
}
