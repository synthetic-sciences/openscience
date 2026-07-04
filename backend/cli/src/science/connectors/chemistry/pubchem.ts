import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

/**
 * PubChem — NCBI's public chemical database (PUG REST). No key required.
 *   search: name -> CIDs (word match), then a batched property table.
 *     GET /rest/pug/compound/name/<query>/cids/JSON?name_type=word
 *     GET /rest/pug/compound/cid/<csv>/property/<fields>/JSON
 *   fetch:  GET /rest/pug/compound/cid/<CID>/JSON  (full compound record)
 */
const BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
const FIELDS = "Title,MolecularFormula,MolecularWeight,ConnectivitySMILES,InChIKey,IUPACName"

interface Property {
  CID?: number
  Title?: string
  IUPACName?: string
  MolecularFormula?: string
  MolecularWeight?: string
  ConnectivitySMILES?: string
  InChIKey?: string
  [key: string]: unknown
}

function summarize(p: Property): string | undefined {
  const parts = [
    p.MolecularFormula ? `Formula ${p.MolecularFormula}` : undefined,
    p.MolecularWeight ? `MW ${p.MolecularWeight}` : undefined,
    p.ConnectivitySMILES ? `SMILES ${p.ConnectivitySMILES}` : undefined,
    p.InChIKey ? p.InChIKey : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

export const pubchem: Connector = {
  id: "pubchem",
  name: "PubChem",
  domain: "chemistry",
  description: "Chemical compounds, structures, and properties from NCBI PubChem.",
  homepage: "https://pubchem.ncbi.nlm.nih.gov",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 25)
    const cidUrl = `${BASE}/compound/name/${encodeURIComponent(query)}/cids/JSON?name_type=word`
    const cidData = await getJSON<{ IdentifierList?: { CID?: number[] } }>(cidUrl, {
      signal: opts?.signal,
    }).catch(() => ({}) as { IdentifierList?: { CID?: number[] } })
    const cids = (cidData.IdentifierList?.CID ?? []).slice(0, limit)
    if (!cids.length) return []

    const propUrl = `${BASE}/compound/cid/${cids.join(",")}/property/${FIELDS}/JSON`
    const propData = await getJSON<{ PropertyTable?: { Properties?: Property[] } }>(propUrl, {
      signal: opts?.signal,
    }).catch(() => ({}) as { PropertyTable?: { Properties?: Property[] } })
    const props = propData.PropertyTable?.Properties ?? []

    return props.map<ConnectorHit>((p) => {
      const cid = p.CID != null ? String(p.CID) : ""
      return {
        id: cid,
        title: p.Title ?? p.IUPACName ?? (cid ? `CID ${cid}` : "(unknown compound)"),
        summary: summarize(p),
        url: cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}` : undefined,
        extra: p,
      }
    })
  },

  async fetch(id, opts) {
    const url = `${BASE}/compound/cid/${encodeURIComponent(id)}/JSON`
    return getJSON(url, { signal: opts?.signal })
  },
}
