/**
 * SIFTS — residue-level mappings between UniProt sequences and PDB structures
 * (plus Pfam, InterPro, CATH, SCOP), served by PDBe.
 *
 * best_structures: https://www.ebi.ac.uk/pdbe/api/mappings/best_structures/{acc}
 * full mappings:   https://www.ebi.ac.uk/pdbe/api/mappings/{acc}
 *
 * `search` is keyed by UniProt accession and returns the best experimental PDB
 * structures covering that protein; a free-text query is resolved to an
 * accession via UniProt first. `fetch` returns the full SIFTS mapping record.
 */
import type { Connector, ConnectorHit, FetchOptions, SearchOptions } from "../types"
import { getJSON } from "../http"
import { asArray, clampLimit, looksLikeAccession, resolveUniProtAccessions, toRaw } from "./util"

interface BestStructure {
  pdb_id?: string
  chain_id?: string
  experimental_method?: string
  resolution?: number
  unp_start?: number
  unp_end?: number
  coverage?: number
}

const MAPPINGS = "https://www.ebi.ac.uk/pdbe/api/mappings"

async function bestStructures(accession: string, signal?: AbortSignal): Promise<BestStructure[]> {
  try {
    const data = await getJSON<Record<string, unknown>>(
      `${MAPPINGS}/best_structures/${encodeURIComponent(accession)}`,
      { signal },
    )
    return asArray<BestStructure>(data[accession])
  } catch {
    return []
  }
}

function toHit(accession: string, s: BestStructure): ConnectorHit {
  const pdb = s.pdb_id ?? "unknown"
  const chain = s.chain_id ? ` chain ${s.chain_id}` : ""
  const parts = [
    s.experimental_method,
    typeof s.resolution === "number" ? `${s.resolution} Å` : undefined,
    typeof s.unp_start === "number" && typeof s.unp_end === "number"
      ? `UniProt ${s.unp_start}-${s.unp_end}`
      : undefined,
    typeof s.coverage === "number" ? `coverage ${(s.coverage * 100).toFixed(0)}%` : undefined,
  ].filter(Boolean)
  return {
    id: `${accession}:${pdb}${s.chain_id ? `_${s.chain_id}` : ""}`,
    title: `${pdb.toUpperCase()}${chain} ↔ ${accession}`,
    summary: parts.length ? parts.join(", ") : undefined,
    url: `https://www.ebi.ac.uk/pdbe/entry/pdb/${pdb}`,
    score: s.coverage,
    extra: toRaw(s),
  }
}

export const sifts: Connector = {
  id: "sifts",
  name: "SIFTS",
  domain: "structure",
  description: "UniProt↔PDB residue-level structure mappings (best PDB structures per protein).",
  homepage: "https://www.ebi.ac.uk/pdbe/docs/sifts",

  async search(query, opts?: SearchOptions): Promise<ConnectorHit[]> {
    const limit = clampLimit(opts?.limit, 10, 25)
    const q = query.trim()
    const accessions = looksLikeAccession(q) ? [q] : await resolveUniProtAccessions(query, 3, opts?.signal)
    const hits: ConnectorHit[] = []
    for (const acc of accessions) {
      const structures = await bestStructures(acc, opts?.signal)
      for (const s of structures) {
        hits.push(toHit(acc, s))
        if (hits.length >= limit) return hits
      }
    }
    return hits
  },

  async fetch(id, opts?: FetchOptions): Promise<unknown> {
    // Accept either a bare accession or a "<acc>:<pdb>" hit id.
    const accession = id.split(":")[0]
    return getJSON(`${MAPPINGS}/${encodeURIComponent(accession)}`, { signal: opts?.signal })
  },
}
