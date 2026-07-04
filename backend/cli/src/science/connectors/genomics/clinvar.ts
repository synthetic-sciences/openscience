/**
 * NCBI ClinVar via Entrez E-utilities — clinically-interpreted variants.
 * Public, keyless (eutils.ncbi.nlm.nih.gov, db=clinvar).
 */
import type { Connector, ConnectorHit } from "../types"
import { esearch, esummary, esummaryOne } from "./eutils"
import { arr, asRecord, str, summarize, type Rec } from "./util"

/** Classification block moved to `germline_classification` in newer ClinVar summaries. */
function classification(rec: Rec): { significance?: string; traits: string[] } {
  const germline = asRecord(rec.germline_classification)
  const significance = str(germline.description) ?? str(rec.clinical_significance)
  const traits = arr(germline.trait_set)
    .map((t) => str(asRecord(t).trait_name))
    .filter((name): name is string => typeof name === "string")
  return { significance, traits }
}

function variantHit(rec: Rec): ConnectorHit {
  const uid = str(rec.uid) ?? ""
  const accession = str(rec.accession)
  const { significance, traits } = classification(rec)
  return {
    id: uid,
    title: str(rec.title) ?? accession ?? uid,
    summary: summarize([
      significance ? `significance: ${significance}` : undefined,
      str(rec.gene_sort) ? `gene: ${str(rec.gene_sort)}` : undefined,
      str(rec.protein_change) ? `protein: ${str(rec.protein_change)}` : undefined,
      traits.length > 0 ? `conditions: ${traits.join("; ")}` : undefined,
      accession,
    ]),
    url: uid ? `https://www.ncbi.nlm.nih.gov/clinvar/variation/${uid}/` : undefined,
    extra: rec,
  }
}

export const clinvar: Connector = {
  id: "clinvar",
  name: "ClinVar",
  domain: "clinical",
  description: "Clinically-interpreted variants: pathogenicity classification, conditions, and gene.",
  homepage: "https://www.ncbi.nlm.nih.gov/clinvar",

  async search(query, opts) {
    const term = query.trim()
    if (term.length === 0) return []
    const retmax = Math.min(opts?.limit ?? 10, 25)
    const ids = await esearch("clinvar", term, retmax, opts?.signal)
    const records = await esummary("clinvar", ids, opts?.signal)
    return records.map(variantHit).filter((hit) => hit.id.length > 0)
  },

  async fetch(id, opts) {
    return (await esummaryOne("clinvar", id.trim(), opts?.signal)) ?? {}
  },
}
