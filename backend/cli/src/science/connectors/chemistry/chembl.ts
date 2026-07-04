import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

/**
 * ChEMBL — bioactive drug-like small molecules curated by EMBL-EBI.
 * Public REST API, no key required.
 *   search: GET /chembl/api/data/molecule/search.json?q=<query>
 *   fetch:  GET /chembl/api/data/molecule/<CHEMBL_ID>.json
 */
const BASE = "https://www.ebi.ac.uk/chembl/api/data"

interface Molecule {
  molecule_chembl_id?: string
  pref_name?: string | null
  max_phase?: string | number | null
  molecule_structures?: { canonical_smiles?: string | null } | null
  molecule_properties?: { full_mwt?: string | null; full_molformula?: string | null } | null
  [key: string]: unknown
}

function summarize(m: Molecule): string | undefined {
  const props = m.molecule_properties ?? undefined
  const smiles = m.molecule_structures?.canonical_smiles ?? undefined
  const parts = [
    props?.full_molformula ? `Formula ${props.full_molformula}` : undefined,
    props?.full_mwt ? `MW ${props.full_mwt}` : undefined,
    m.max_phase != null && m.max_phase !== "" ? `Max phase ${m.max_phase}` : undefined,
    smiles ? `SMILES ${smiles}` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

export const chembl: Connector = {
  id: "chembl",
  name: "ChEMBL",
  domain: "chemistry",
  description: "Bioactive drug-like small molecules with curated bioactivity data (EMBL-EBI).",
  homepage: "https://www.ebi.ac.uk/chembl",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 25)
    const url = `${BASE}/molecule/search.json?q=${encodeURIComponent(query)}&limit=${limit}`
    const data = await getJSON<{ molecules?: Molecule[] }>(url, { signal: opts?.signal }).catch(
      () => ({}) as { molecules?: Molecule[] },
    )
    const molecules = Array.isArray(data.molecules) ? data.molecules : []
    return molecules.slice(0, limit).map<ConnectorHit>((m) => {
      const id = m.molecule_chembl_id ?? ""
      return {
        id,
        title: m.pref_name ?? id ?? "(unnamed molecule)",
        summary: summarize(m),
        url: id ? `https://www.ebi.ac.uk/chembl/explore/compound/${id}` : undefined,
        extra: m,
      }
    })
  },

  async fetch(id, opts) {
    const url = `${BASE}/molecule/${encodeURIComponent(id)}.json`
    return getJSON(url, { signal: opts?.signal })
  },
}
