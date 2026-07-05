import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

/**
 * Guide to PHARMACOLOGY (GtoPdb) — IUPHAR/BPS ligand & target pharmacology.
 * Public JSON web services, no key required.
 *   search: GET /services/ligands?name=<query>
 *   fetch:  GET /services/ligands/<id>  (+ /structure merged for SMILES/InChI)
 */
const BASE = "https://www.guidetopharmacology.org/services"

interface Ligand {
  ligandId?: number
  name?: string
  type?: string
  inn?: string | null
  approved?: boolean
  approvalSource?: string | null
  [key: string]: unknown
}

interface Structure {
  smiles?: string
  inchiKey?: string
  iupacName?: string
  [key: string]: unknown
}

function summarize(l: Ligand): string | undefined {
  const parts = [
    l.type,
    l.approved ? `approved${l.approvalSource ? ` (${l.approvalSource})` : ""}` : undefined,
    l.inn ? `INN ${l.inn}` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

export const gtopdb: Connector = {
  id: "gtopdb",
  name: "Guide to PHARMACOLOGY",
  domain: "chemistry",
  description: "IUPHAR/BPS ligands, drugs, and their molecular targets.",
  homepage: "https://www.guidetopharmacology.org",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 25)
    const url = `${BASE}/ligands?name=${encodeURIComponent(query)}`
    const data = await getJSON<Ligand[]>(url, { signal: opts?.signal }).catch(() => [])
    const ligands = Array.isArray(data) ? data : []
    return ligands.slice(0, limit).map<ConnectorHit>((l) => {
      const id = l.ligandId != null ? String(l.ligandId) : ""
      return {
        id,
        title: l.name ?? (id ? `Ligand ${id}` : "(unnamed ligand)"),
        summary: summarize(l),
        url: id ? `https://www.guidetopharmacology.org/GRAC/LigandDisplayForward?ligandId=${id}` : undefined,
        extra: l,
      }
    })
  },

  async fetch(id, opts) {
    const base = `${BASE}/ligands/${encodeURIComponent(id)}`
    const [ligand, structure] = await Promise.all([
      getJSON<Ligand>(base, { signal: opts?.signal }).catch(() => ({}) as Ligand),
      getJSON<Structure>(`${base}/structure`, { signal: opts?.signal }).catch(() => ({}) as Structure),
    ])
    return { ...ligand, ...structure }
  },
}
