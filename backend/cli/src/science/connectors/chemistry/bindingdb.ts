import type { Connector, ConnectorHit } from "../types"
import { getText, SourceResponseError } from "../http"

/**
 * BindingDB — measured binding affinities between proteins and small molecules.
 * Public REST API (target-centric), no key required. Queries are UniProt
 * accessions; the connector returns the ligands measured against that target.
 *   search/fetch: GET /rest/getLigandsByUniprots?uniprot=<acc>&cutoff=<nM>&code=0&response=application/json
 * The JSON wrapper key is source-typo'd ("getLindsByUniprotsResponse"), so we
 * locate the object carrying `affinities` defensively rather than by key name.
 */
const BASE = "https://bindingdb.org/rest"
const CUTOFF = 10_000

interface Affinity {
  query?: string
  monomerid?: string | number
  smile?: string
  affinity_type?: string
  affinity?: string | number
  pmid?: string
  doi?: string
  [key: string]: unknown
}

function affinitiesOf(body: unknown): Affinity[] {
  if (body === "") return []
  if (!body || typeof body !== "object")
    throw new SourceResponseError("BindingDB returned an invalid affinity response")
  const wrapper = Object.values(body as Record<string, unknown>).find(
    (v) => v != null && typeof v === "object" && "affinities" in (v as Record<string, unknown>),
  ) as { affinities?: unknown } | undefined
  const raw = wrapper?.affinities
  if (Array.isArray(raw)) return raw as Affinity[]
  if (raw && typeof raw === "object") return [raw as Affinity]
  if (raw === null || (raw === undefined && wrapper)) return []
  throw new SourceResponseError("BindingDB response is missing its affinity collection")
}

function ligandsUrl(uniprot: string): string {
  return `${BASE}/getLigandsByUniprots?uniprot=${encodeURIComponent(uniprot)}&cutoff=${CUTOFF}&code=0&response=application/json`
}

// BindingDB documents a successful empty body for no matching UniProt target.
// Keep that specific absence case separate from HTTP/API/invalid JSON failures.
async function targetData(target: string, signal?: AbortSignal): Promise<unknown> {
  const body = await getText(ligandsUrl(target), { signal, allowEmptyBody: true })
  return body.trim() ? JSON.parse(body) : ""
}

export const bindingdb: Connector = {
  id: "bindingdb",
  name: "BindingDB",
  domain: "chemistry",
  description: "Measured protein-ligand binding affinities; query by UniProt accession.",
  homepage: "https://www.bindingdb.org",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 25)
    const target = query.trim()
    const body = await targetData(target, opts?.signal)
    const affinities = affinitiesOf(body)
    return affinities.slice(0, limit).map<ConnectorHit>((a) => {
      const mid = a?.monomerid != null ? String(a.monomerid) : ""
      if (!/^\d+$/.test(mid))
        throw new SourceResponseError("BindingDB affinity record is missing a valid monomer identifier")
      const measure = [a.affinity_type, a.affinity != null ? `${a.affinity} nM` : undefined].filter(Boolean).join(" ")
      return {
        id: `uniprot:${encodeURIComponent(target)}:monomer:${mid}`,
        title: measure ? `${measure}${a.query ? ` — ${a.query}` : ""}` : (a.query ?? `Monomer ${mid}`),
        summary: a.smile,
        url: mid ? `https://www.bindingdb.org/rwd/bind/chemsearch/marvin/MolStructure.jsp?monomerid=${mid}` : undefined,
        extra: a,
      }
    })
  },

  async fetch(id, opts) {
    const value = id.trim()
    const hit = /^uniprot:([^:]+):monomer:(\d+)$/.exec(value)
    if (hit) {
      const target = decodeURIComponent(hit[1]!)
      const body = await targetData(target, opts?.signal)
      const affinities = affinitiesOf(body).filter((row) => String(row.monomerid) === hit[2])
      return affinities.length ? { target_uniprot: target, monomerid: hit[2], affinities } : { id: value, found: false }
    }
    if (/^\d+$/.test(value) || value.startsWith("uniprot:")) {
      throw new Error(
        "BindingDB fetch needs a search hit ID (uniprot:ACCESSION:monomer:ID) or a bare UniProt accession; search again to recover the target",
      )
    }
    // Preserve direct target lookup for callers that already hold a UniProt accession.
    const body = await targetData(value, opts?.signal)
    return affinitiesOf(body).length ? body : { id: value, found: false }
  },
}
