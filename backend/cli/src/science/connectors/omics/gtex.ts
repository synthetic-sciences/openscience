/**
 * GTEx (Genotype-Tissue Expression) connector.
 *
 * Uses the public GTEx Portal REST API v2 (no key). Because GTEx is organised
 * around genes and their tissue-level expression, "search" resolves a gene
 * query to its GTEx gene record(s), and "fetch" returns the median expression
 * of that gene across every GTEx tissue.
 *
 * search()  → /api/v2/reference/gene?geneId=...
 * fetch(id) → gene record + /api/v2/expression/medianGeneExpression?gencodeId=...
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

const BASE = "https://gtexportal.org/api/v2"

interface GtexGene {
  geneSymbol?: string
  gencodeId?: string
  entrezGeneId?: number
  description?: string
  chromosome?: string
  start?: number
  end?: number
  strand?: string
  geneType?: string
  genomeBuild?: string
}

interface GtexGeneResponse {
  data?: GtexGene[]
}

interface GtexMedian {
  median?: number
  tissueSiteDetailId?: string
  gencodeId?: string
  geneSymbol?: string
  unit?: string
}

interface GtexMedianResponse {
  data?: GtexMedian[]
}

function geneUrl(symbol: string): string {
  return `https://gtexportal.org/home/gene/${encodeURIComponent(symbol)}`
}

function toHit(g: GtexGene): ConnectorHit {
  const symbol = g.geneSymbol ?? g.gencodeId ?? "unknown"
  const loc = g.chromosome ? `${g.chromosome}:${g.start ?? "?"}-${g.end ?? "?"}` : undefined
  const summaryBits = [g.description, g.geneType, loc].filter((x): x is string => Boolean(x))
  return {
    id: g.gencodeId ?? symbol,
    title: `${symbol}${g.description ? ` — ${g.description}` : ""}`,
    summary: summaryBits.join(" · ") || undefined,
    url: geneUrl(symbol),
    extra: { ...g },
  }
}

async function lookupGene(geneId: string, limit: number, signal?: AbortSignal): Promise<GtexGene[]> {
  const url = `${BASE}/reference/gene?geneId=${encodeURIComponent(geneId)}&itemsPerPage=${limit}`
  const data = await getJSON<GtexGeneResponse>(url, { signal }).catch(() => ({}) as GtexGeneResponse)
  return data.data ?? []
}

export const gtex: Connector = {
  id: "gtex",
  name: "GTEx",
  domain: "genomics",
  description: "Genotype-Tissue Expression — median gene expression across human tissues.",
  homepage: "https://gtexportal.org",

  async search(query, opts) {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const genes = await lookupGene(query, limit, opts?.signal)
    return genes.map(toHit)
  },

  async fetch(id, opts) {
    const trimmed = id.trim()
    // Resolve to a versioned gencodeId when the caller passed a symbol/entrez id.
    const isGencode = /^ENSG\d+/i.test(trimmed)
    const genes = await lookupGene(trimmed, 5, opts?.signal)
    const gene = isGencode ? (genes.find((g) => g.gencodeId?.startsWith(trimmed.split(".")[0])) ?? genes[0]) : genes[0]
    const gencodeId = gene?.gencodeId ?? (isGencode ? trimmed : undefined)
    if (!gencodeId) return { id: trimmed, found: false }
    const median = await getJSON<GtexMedianResponse>(
      `${BASE}/expression/medianGeneExpression?gencodeId=${encodeURIComponent(gencodeId)}&itemsPerPage=100`,
      { signal: opts?.signal },
    ).catch(() => ({}) as GtexMedianResponse)
    return { gene: gene ?? { gencodeId }, medianExpression: median.data ?? [] }
  },
}
