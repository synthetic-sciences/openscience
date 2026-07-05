/**
 * Single Cell Expression Atlas (EMBL-EBI GXA sc) connector.
 *
 * Mirrors the bulk Expression Atlas connector but targets the single-cell
 * catalogue (`/gxa/sc/json/experiments`). There is no per-experiment JSON
 * endpoint, so `fetch` returns the matching catalogue entry. No API key.
 *
 * search()  → filter /gxa/sc/json/experiments
 * fetch(id) → catalogue entry for {accession}
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

const BASE = "https://www.ebi.ac.uk/gxa/sc"

interface ScExperiment {
  experimentAccession?: string
  experimentDescription?: string
  species?: string
  kingdom?: string
  loadDate?: string
  lastUpdate?: string
  experimentType?: string
  rawExperimentType?: string
  technologyType?: string[]
  numberOfAssays?: number
  experimentalFactors?: string[]
}

interface ScExperiments {
  experiments?: ScExperiment[]
}

function haystack(e: ScExperiment): string {
  return [
    e.experimentAccession,
    e.experimentDescription,
    e.species,
    e.experimentType,
    ...(e.experimentalFactors ?? []),
    ...(e.technologyType ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function toHit(e: ScExperiment): ConnectorHit {
  const accession = e.experimentAccession ?? "unknown"
  const factors = e.experimentalFactors?.length ? e.experimentalFactors.slice(0, 5).join(", ") : undefined
  const assays = typeof e.numberOfAssays === "number" ? `${e.numberOfAssays} cells/assays` : undefined
  const summaryBits = [e.species, assays, factors].filter((x): x is string => Boolean(x))
  return {
    id: accession,
    title: e.experimentDescription ?? accession,
    summary: summaryBits.join(" · ") || undefined,
    url: `${BASE}/experiments/${encodeURIComponent(accession)}`,
    extra: { ...e },
  }
}

async function catalogue(signal?: AbortSignal): Promise<ScExperiment[]> {
  const data = await getJSON<ScExperiments>(`${BASE}/json/experiments`, { signal }).catch(() => ({}) as ScExperiments)
  return data.experiments ?? []
}

export const singleCellAtlas: Connector = {
  id: "single-cell-atlas",
  name: "Single Cell Expression Atlas",
  domain: "genomics",
  description: "Single-cell RNA-seq experiments with cell-type expression across species (EMBL-EBI GXA sc).",
  homepage: "https://www.ebi.ac.uk/gxa/sc",

  async search(query, opts) {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const needle = query.trim().toLowerCase()
    const experiments = await catalogue(opts?.signal)
    const matched = needle ? experiments.filter((e) => haystack(e).includes(needle)) : experiments
    return matched.slice(0, limit).map(toHit)
  },

  async fetch(id, opts) {
    const accession = id.trim()
    const experiments = await catalogue(opts?.signal)
    return experiments.find((e) => e.experimentAccession === accession) ?? { id: accession, found: false }
  },
}
