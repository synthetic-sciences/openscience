/**
 * Ensembl REST — genes, transcripts, and cross-references by symbol / stable id.
 * Public, keyless API at rest.ensembl.org.
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { arr, asRecord, num, str, summarize, type Rec } from "./util"

const REST = "https://rest.ensembl.org"

function ensemblUrl(id: string): string {
  return `https://www.ensembl.org/id/${encodeURIComponent(id)}`
}

/** Map a rich lookup record (gene/transcript) to a normalized hit. */
function lookupHit(rec: Rec): ConnectorHit {
  const id = str(rec.id) ?? ""
  const region = str(rec.seq_region_name)
  const start = num(rec.start)
  const end = num(rec.end)
  const location = region && start !== undefined && end !== undefined ? `${region}:${start}-${end}` : undefined
  const biotype = str(rec.biotype)
  return {
    id,
    title: str(rec.display_name) ?? id,
    summary: summarize([
      str(rec.description),
      biotype ? `biotype: ${biotype}` : undefined,
      location ? `location: ${location}` : undefined,
      str(rec.object_type) ? `type: ${str(rec.object_type)}` : undefined,
    ]),
    url: id ? ensemblUrl(id) : undefined,
    extra: rec,
  }
}

export const ensembl: Connector = {
  id: "ensembl",
  name: "Ensembl",
  domain: "genomics",
  description: "Genes, transcripts, and cross-references by symbol or Ensembl stable id.",
  homepage: "https://www.ensembl.org",

  async search(query, opts) {
    const species = str(opts?.organism) ?? "homo_sapiens"
    const symbol = query.trim()
    if (symbol.length === 0) return []
    const signal = opts?.signal
    const limit = Math.min(opts?.limit ?? 10, 25)

    // 1) Exact symbol lookup returns a single, richly-annotated gene record.
    try {
      const gene = await getJSON<Rec>(
        `${REST}/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}?content-type=application/json`,
        { signal },
      )
      if (str(gene.id)) return [lookupHit(gene)]
    } catch {
      // fall through to the broader xref lookup
    }

    // 2) Fallback: cross-reference search returns candidate stable ids by type.
    try {
      const xrefs = await getJSON<unknown>(
        `${REST}/xrefs/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}?content-type=application/json`,
        { signal },
      )
      return arr(xrefs)
        .slice(0, limit)
        .map<ConnectorHit>((entry) => {
          const rec = asRecord(entry)
          const id = str(rec.id) ?? ""
          const type = str(rec.type)
          return {
            id,
            title: id,
            summary: type ? `Ensembl ${type} matching ${symbol}` : undefined,
            url: id ? ensemblUrl(id) : undefined,
            extra: rec,
          }
        })
        .filter((hit) => hit.id.length > 0)
    } catch {
      return []
    }
  },

  async fetch(id, opts) {
    const stable = id.trim()
    return getJSON<Rec>(`${REST}/lookup/id/${encodeURIComponent(stable)}?expand=1&content-type=application/json`, {
      signal: opts?.signal,
    })
  },
}
