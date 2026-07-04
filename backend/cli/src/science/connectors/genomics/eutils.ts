/**
 * Thin, shared NCBI E-utilities (Entrez) client used by the gene / dbSNP /
 * ClinVar connectors. No API key — public rate limits apply, and the shared
 * HTTP helper already handles retry/backoff on 429/5xx.
 *
 * Docs: https://www.ncbi.nlm.nih.gov/books/NBK25501/
 */
import { getJSON } from "../http"
import { arr, asRecord, type Rec } from "./util"

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
const TOOL = "openscience-science"

interface ESearchEnvelope {
  esearchresult?: { idlist?: unknown; count?: string }
}

interface ESummaryEnvelope {
  result?: Rec
}

/** Run an ESearch against `db`, returning the ordered list of matching UIDs. */
export async function esearch(db: string, term: string, retmax: number, signal?: AbortSignal): Promise<string[]> {
  const url =
    `${BASE}/esearch.fcgi?db=${encodeURIComponent(db)}` +
    `&term=${encodeURIComponent(term)}&retmode=json&retmax=${retmax}&tool=${TOOL}`
  const data = await getJSON<ESearchEnvelope>(url, { signal })
  return arr(data.esearchresult?.idlist)
    .map((id) => (typeof id === "string" ? id : String(id)))
    .filter((id) => id.length > 0)
}

/** Run an ESummary for the given UIDs, returning one record per UID (order preserved). */
export async function esummary(db: string, ids: string[], signal?: AbortSignal): Promise<Rec[]> {
  if (ids.length === 0) return []
  const url =
    `${BASE}/esummary.fcgi?db=${encodeURIComponent(db)}` +
    `&id=${ids.map(encodeURIComponent).join(",")}&retmode=json&tool=${TOOL}`
  const data = await getJSON<ESummaryEnvelope>(url, { signal })
  const result = data.result
  if (!result) return []
  const uids = arr(result["uids"]).map((u) => (typeof u === "string" ? u : String(u)))
  const order = uids.length > 0 ? uids : ids
  return order.map((uid) => asRecord(result[uid])).filter((rec) => Object.keys(rec).length > 0)
}

/** Convenience: ESummary for a single UID. */
export async function esummaryOne(db: string, id: string, signal?: AbortSignal): Promise<Rec | undefined> {
  const records = await esummary(db, [id], signal)
  return records[0]
}
