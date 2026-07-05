import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

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
  if (!body || typeof body !== "object") return []
  const wrapper = Object.values(body as Record<string, unknown>).find(
    (v) => v != null && typeof v === "object" && "affinities" in (v as Record<string, unknown>),
  ) as { affinities?: unknown } | undefined
  const raw = wrapper?.affinities
  if (Array.isArray(raw)) return raw as Affinity[]
  if (raw && typeof raw === "object") return [raw as Affinity]
  return []
}

function ligandsUrl(uniprot: string): string {
  return `${BASE}/getLigandsByUniprots?uniprot=${encodeURIComponent(uniprot)}&cutoff=${CUTOFF}&code=0&response=application/json`
}

export const bindingdb: Connector = {
  id: "bindingdb",
  name: "BindingDB",
  domain: "chemistry",
  description: "Measured protein-ligand binding affinities; query by UniProt accession.",
  homepage: "https://www.bindingdb.org",

  async search(query, opts) {
    const limit = Math.min(opts?.limit ?? 10, 25)
    const body = await getJSON<unknown>(ligandsUrl(query.trim()), { signal: opts?.signal }).catch(() => undefined)
    const affinities = affinitiesOf(body)
    return affinities.slice(0, limit).map<ConnectorHit>((a) => {
      const mid = a.monomerid != null ? String(a.monomerid) : ""
      const measure = [a.affinity_type, a.affinity != null ? `${a.affinity} nM` : undefined].filter(Boolean).join(" ")
      return {
        id: mid,
        title: measure ? `${measure}${a.query ? ` — ${a.query}` : ""}` : (a.query ?? `Monomer ${mid}`),
        summary: a.smile,
        url: mid ? `https://www.bindingdb.org/rwd/bind/chemsearch/marvin/MolStructure.jsp?monomerid=${mid}` : undefined,
        extra: a,
      }
    })
  },

  async fetch(id, opts) {
    // id is a UniProt accession; returns the full ligand-affinity set for the target.
    return getJSON(ligandsUrl(id.trim()), { signal: opts?.signal }).catch(() => ({ affinities: [] }))
  },
}
