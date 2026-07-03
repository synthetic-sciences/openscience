import type { Connector, ConnectorHit } from "../types"
import { getJSON, request } from "../http"

/**
 * SureChEMBL — chemistry mined from the patent literature (EMBL-EBI). Public API,
 * no key required.
 *   search: POST /api/search/content?query=<q>&page=1&itemsPerPage=<n>  -> patent documents
 *   fetch:  numeric id -> GET /api/chemical/id/<id> (compound record)
 *           patent id  -> content search scoped to that document number
 */
const BASE = "https://www.surechembl.org/api"

interface Title {
  lang?: string
  titles?: string[]
}

interface Document {
  docId?: string
  pa?: string
  metadata?: { pd?: string; pn?: string; titles?: Title[]; pdfLink?: string }
  [key: string]: unknown
}

interface Chemical {
  id?: string
  chemical_id?: string
  name?: string
  smiles?: string
  mol_formula?: string
  [key: string]: unknown
}

function pickTitle(doc: Document): string {
  const titles = doc.metadata?.titles ?? []
  const english = titles.find((t) => t.lang === "en")
  const chosen = english ?? titles[0]
  return chosen?.titles?.[0] ?? doc.docId ?? "(untitled patent)"
}

async function searchContent(query: string, itemsPerPage: number, signal?: AbortSignal): Promise<Document[]> {
  const url = `${BASE}/search/content?query=${encodeURIComponent(query)}&page=1&itemsPerPage=${itemsPerPage}`
  const res = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal,
  }).catch(() => undefined)
  if (!res) return []
  const body = res.json<{ data?: { results?: { documents?: Document[] } } }>()
  const docs = body.data?.results?.documents
  return Array.isArray(docs) ? docs : []
}

export const surechembl: Connector = {
  id: "surechembl",
  name: "SureChEMBL",
  domain: "chemistry",
  description: "Chemistry extracted from the patent literature (EMBL-EBI).",
  homepage: "https://www.surechembl.org",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 25)
    const docs = await searchContent(query, limit, opts?.signal)
    return docs.slice(0, limit).map<ConnectorHit>((doc) => {
      const id = doc.docId ?? doc.metadata?.pn ?? ""
      const meta = [doc.pa, doc.metadata?.pd].filter(Boolean).join(" · ")
      return {
        id,
        title: pickTitle(doc),
        summary: meta || undefined,
        url: id ? `https://www.surechembl.org/patent/${id}` : undefined,
        extra: doc,
      }
    })
  },

  async fetch(id, opts) {
    if (/^\d+$/.test(id.trim())) {
      const data = await getJSON<{ data?: Chemical[] }>(`${BASE}/chemical/id/${encodeURIComponent(id.trim())}`, {
        signal: opts?.signal,
      }).catch(() => ({}) as { data?: Chemical[] })
      const records = Array.isArray(data.data) ? data.data : []
      return records[0] ?? {}
    }
    const docs = await searchContent(id, 5, opts?.signal)
    return docs.find((d) => d.docId === id) ?? docs[0] ?? {}
  },
}
