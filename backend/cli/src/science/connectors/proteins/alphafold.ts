/**
 * AlphaFold DB — predicted 3D structures for (almost) every UniProt sequence.
 *
 * API: https://alphafold.ebi.ac.uk/api/prediction/{uniprot_accession}
 *
 * The API is keyed by UniProt accession only (no free-text search), so a query
 * is first tried as an accession; if that yields nothing it is resolved to
 * accessions via UniProt and each prediction is fetched.
 */
import type { Connector, ConnectorHit, FetchedFile, FetchOptions, SearchOptions } from "../types"
import { getJSON, getText } from "../http"
import { asArray, clampLimit, firstString, looksLikeAccession, resolveUniProtAccessions, toRaw } from "./util"

interface Prediction {
  entryId?: string
  uniprotAccession?: string
  uniprotId?: string
  uniprotDescription?: string
  organismScientificName?: string
  gene?: string
  globalMetricValue?: number
  pdbUrl?: string
  cifUrl?: string
}

const API = "https://alphafold.ebi.ac.uk/api/prediction"

async function predict(accession: string, signal?: AbortSignal): Promise<Prediction[]> {
  try {
    return asArray<Prediction>(await getJSON(`${API}/${encodeURIComponent(accession)}`, { signal }))
  } catch {
    return []
  }
}

function toHit(p: Prediction): ConnectorHit {
  const acc = p.uniprotAccession ?? p.entryId ?? "unknown"
  const plddt = typeof p.globalMetricValue === "number" ? `mean pLDDT ${p.globalMetricValue.toFixed(1)}` : undefined
  const org = p.organismScientificName ? `Organism: ${p.organismScientificName}` : undefined
  return {
    id: acc,
    title: firstString(p.uniprotDescription, p.uniprotId, p.entryId) ?? acc,
    summary: [plddt, org].filter(Boolean).join(" · ") || undefined,
    url: `https://alphafold.ebi.ac.uk/entry/${acc}`,
    score: p.globalMetricValue,
    extra: toRaw(p),
  }
}

export const alphafold: Connector = {
  id: "alphafold",
  name: "AlphaFold DB",
  domain: "structure",
  description: "AlphaFold-predicted protein structures with per-residue confidence (pLDDT).",
  homepage: "https://alphafold.ebi.ac.uk",

  async search(query, opts?: SearchOptions): Promise<ConnectorHit[]> {
    const limit = clampLimit(opts?.limit, 5, 25)
    const q = query.trim()
    if (looksLikeAccession(q)) {
      const direct = await predict(q, opts?.signal)
      if (direct.length) return direct.map(toHit)
    }
    const accessions = await resolveUniProtAccessions(query, limit, opts?.signal)
    const batches = await Promise.all(accessions.map((a) => predict(a, opts?.signal)))
    return batches.flat().slice(0, limit).map(toHit)
  },

  async fetch(id, opts?: FetchOptions): Promise<unknown> {
    return getJSON(`${API}/${encodeURIComponent(id)}`, { signal: opts?.signal })
  },

  formats: ["pdb", "cif"],

  // AlphaFold's file URLs are only discoverable inside the JSON record, so this
  // fetches the prediction first and follows the URL it carries. That is why
  // format resolution lives in the connector rather than an id -> URL map.
  async fetchFile(id, format, opts?: FetchOptions): Promise<FetchedFile> {
    const predictions = await predict(id, opts?.signal)
    const first = predictions[0]
    const url = format === "pdb" ? first?.pdbUrl : first?.cifUrl
    if (!url) throw new Error(`AlphaFold has no ${format} file for "${id}".`)
    const body = await getText(url, { signal: opts?.signal })
    return {
      body,
      contentType: format === "cif" ? "chemical/x-cif" : "chemical/x-pdb",
      filename: url.split("/").pop() ?? `${id}.${format}`,
    }
  },
}
