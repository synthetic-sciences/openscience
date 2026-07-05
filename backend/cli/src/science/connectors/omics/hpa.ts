/**
 * Human Protein Atlas (HPA) connector.
 *
 * Uses HPA's public search-download JSON endpoint (no key) for search and the
 * per-gene JSON document (`/{ensembl}.json`) for full records. HPA is organised
 * by gene → protein, so ids are Ensembl gene ids.
 *
 * search()  → /api/search_download.php?...&format=json
 * fetch(id) → /{ensembl}.json  (full HPA record)
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

const BASE = "https://www.proteinatlas.org"
const COLUMNS = "g,gs,eg,up,gd,chr"

interface HpaGene {
  Gene?: string
  "Gene synonym"?: string[]
  Ensembl?: string
  Uniprot?: string[]
  "Gene description"?: string
  Chromosome?: string
}

function geneUrl(ensembl: string): string {
  return `${BASE}/${encodeURIComponent(ensembl)}`
}

function toHit(g: HpaGene): ConnectorHit {
  const ensembl = g.Ensembl ?? "unknown"
  const synonyms = g["Gene synonym"]?.length ? `aka ${g["Gene synonym"].slice(0, 4).join(", ")}` : undefined
  const uniprot = g.Uniprot?.length ? `UniProt ${g.Uniprot.join(", ")}` : undefined
  const summaryBits = [g["Gene description"], synonyms, uniprot].filter((x): x is string => Boolean(x))
  return {
    id: ensembl,
    title: g.Gene ? `${g.Gene}${g["Gene description"] ? ` — ${g["Gene description"]}` : ""}` : ensembl,
    summary: summaryBits.join(" · ") || undefined,
    url: geneUrl(ensembl),
    extra: { ...g },
  }
}

export const hpa: Connector = {
  id: "hpa",
  name: "Human Protein Atlas",
  domain: "proteomics",
  description: "Tissue, cell, pathology, and subcellular protein expression across the human proteome.",
  homepage: "https://www.proteinatlas.org",

  async search(query, opts) {
    const url = `${BASE}/api/search_download.php?search=${encodeURIComponent(query)}&format=json&columns=${COLUMNS}&compress=no`
    const data = await getJSON<HpaGene[]>(url, { signal: opts?.signal }).catch(() => [] as HpaGene[])
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    return (Array.isArray(data) ? data : []).slice(0, limit).map(toHit)
  },

  async fetch(id, opts) {
    const trimmed = id.trim()
    const ensembl = /^ENSG\d+/i.test(trimmed)
      ? trimmed
      : await hpa
          .search(trimmed, { limit: 1, signal: opts?.signal })
          .then((hits) => hits[0]?.id)
          .catch(() => undefined)
    if (!ensembl) return { id: trimmed, found: false }
    return getJSON(`${BASE}/${encodeURIComponent(ensembl)}.json`, { signal: opts?.signal }).catch(() => ({
      id: ensembl,
      found: false,
    }))
  },
}
