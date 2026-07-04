import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { clampLimit, snippet } from "./util"

/** A binary interaction row from the IntAct web service. */
interface IntactInteraction {
  ac?: string
  binaryInteractionId?: number
  idA?: string
  idB?: string
  moleculeA?: string
  moleculeB?: string
  intactNameA?: string
  intactNameB?: string
  type?: string
  detectionMethod?: string
  hostOrganism?: string
}

/** Spring-Data page envelope returned by `findInteractions`. */
interface IntactPage {
  content?: IntactInteraction[]
  totalElements?: number
}

const WS = "https://www.ebi.ac.uk/intact/ws"

/**
 * IntAct (EMBL-EBI) — curated molecular interaction data (protein, RNA, small
 * molecule). Open, no key required.
 */
export const intact: Connector = {
  id: "intact",
  name: "IntAct",
  domain: "proteomics",
  description: "EMBL-EBI molecular interaction database (protein, RNA, small molecule).",
  homepage: "https://www.ebi.ac.uk/intact",

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 50)
    const params = new URLSearchParams({ page: "0", pageSize: String(limit) })
    const url = `${WS}/interaction/findInteractions/${encodeURIComponent(query)}?${params.toString()}`
    const data = await getJSON<IntactPage>(url, { signal: opts?.signal }).catch(() => ({}) as IntactPage)
    const rows = Array.isArray(data.content) ? data.content : []

    return rows.slice(0, limit).map<ConnectorHit>((row) => {
      const a = row.moleculeA ?? row.intactNameA ?? row.idA ?? "?"
      const b = row.moleculeB ?? row.intactNameB ?? row.idB ?? "?"
      const id = row.ac ?? `${row.idA ?? "?"}-${row.idB ?? "?"}`
      const detail = [row.type, row.detectionMethod, row.hostOrganism].filter(Boolean).join(" · ")
      return {
        id,
        title: `${a} — ${b}`,
        summary: snippet(detail),
        url: row.ac ? `https://www.ebi.ac.uk/intact/search?query=${encodeURIComponent(row.ac)}` : undefined,
        extra: { ...row },
      }
    })
  },

  async fetch(id, opts) {
    const params = new URLSearchParams({ page: "0", pageSize: "25" })
    const url = `${WS}/interaction/findInteractions/${encodeURIComponent(id)}?${params.toString()}`
    const data = await getJSON<IntactPage>(url, { signal: opts?.signal }).catch(() => ({}) as IntactPage)
    const rows = Array.isArray(data.content) ? data.content : []
    return rows.find((r) => r.ac === id) ?? rows[0] ?? null
  },
}
