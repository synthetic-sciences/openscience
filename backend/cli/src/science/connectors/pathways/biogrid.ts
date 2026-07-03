import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { asRecord, asText, clampLimit, snippet } from "./util"

/** A single interaction record from the BioGRID webservice (JSON format). */
interface BiogridInteraction {
  BIOGRID_INTERACTION_ID?: number | string
  OFFICIAL_SYMBOL_A?: string
  OFFICIAL_SYMBOL_B?: string
  EXPERIMENTAL_SYSTEM?: string
  EXPERIMENTAL_SYSTEM_TYPE?: string
  PUBMED_ID?: number | string
  PUBMED_AUTHOR?: string
  ORGANISM_A?: number | string
  ORGANISM_B?: number | string
}

const WS = "https://webservice.thebiogrid.org"

/**
 * Resolve the BioGRID access key. BioGRID requires a free 32-char key; we never
 * bake one in. Callers supply it via `opts.params.accessKey` or the
 * `BIOGRID_ACCESS_KEY` environment variable. Without it the connector degrades
 * gracefully to empty results rather than throwing.
 */
function accessKey(params?: Record<string, unknown>): string | undefined {
  return asText(params?.["accessKey"]) ?? asText(process.env["BIOGRID_ACCESS_KEY"])
}

function toHit(row: BiogridInteraction): ConnectorHit | undefined {
  const id = row.BIOGRID_INTERACTION_ID != null ? String(row.BIOGRID_INTERACTION_ID) : undefined
  if (!id) return undefined
  const a = row.OFFICIAL_SYMBOL_A ?? "?"
  const b = row.OFFICIAL_SYMBOL_B ?? "?"
  const detail = [row.EXPERIMENTAL_SYSTEM, row.EXPERIMENTAL_SYSTEM_TYPE, row.PUBMED_AUTHOR].filter(Boolean).join(" · ")
  return {
    id,
    title: `${a} — ${b}`,
    summary: snippet(detail),
    url: `https://thebiogrid.org/interaction/${encodeURIComponent(id)}`,
    extra: { ...row },
  }
}

/**
 * BioGRID — curated protein and genetic interactions. The public webservice
 * requires a free access key (see homepage → "Access the REST Service").
 */
export const biogrid: Connector = {
  id: "biogrid",
  name: "BioGRID",
  domain: "proteomics",
  description: "Curated protein and genetic interactions (needs a free BioGRID access key).",
  homepage: "https://thebiogrid.org",

  async search(query, opts) {
    const key = accessKey(opts?.params)
    if (!key) return []
    const limit = clampLimit(opts?.limit, 10, 50)
    const params = new URLSearchParams({
      accessKey: key,
      geneList: query,
      searchNames: "true",
      searchSynonyms: "true",
      includeInteractors: "true",
      format: "json",
      max: String(limit),
    })
    const taxon = asText(opts?.organism)
    if (taxon) params.set("taxId", taxon)
    const url = `${WS}/interactions/?${params.toString()}`
    const data = await getJSON<unknown>(url, { signal: opts?.signal }).catch(() => null)
    const rec = asRecord(data)
    // BioGRID reports auth/other failures as `{ STATUS: "ERROR", ... }`.
    if (typeof rec["STATUS"] === "string") return []

    const hits: ConnectorHit[] = []
    for (const value of Object.values(rec)) {
      const hit = toHit(value as BiogridInteraction)
      if (hit) hits.push(hit)
      if (hits.length >= limit) break
    }
    return hits
  },

  async fetch(id, opts) {
    const key = accessKey(opts?.params)
    if (!key) {
      return { id, error: "BioGRID access key required (set BIOGRID_ACCESS_KEY or pass params.accessKey)" }
    }
    const params = new URLSearchParams({ accessKey: key, interactionList: id, format: "json" })
    const url = `${WS}/interactions/?${params.toString()}`
    const data = await getJSON<unknown>(url, { signal: opts?.signal }).catch(() => null)
    const rec = asRecord(data)
    if (typeof rec["STATUS"] === "string") return { id, error: "BioGRID request failed" }
    return rec[id] ?? data
  },
}
