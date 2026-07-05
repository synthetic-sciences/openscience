/**
 * Expression Atlas (EMBL-EBI GXA) connector.
 *
 * The bulk Expression Atlas exposes a public JSON catalogue of all experiments
 * (`/gxa/json/experiments`) and a per-experiment JSON document. There is no
 * server-side free-text search endpoint, so `search` fetches the (cached)
 * catalogue once and filters it client-side across accession, description,
 * species, factors, and assay technology. No API key.
 *
 * search()  → filter /gxa/json/experiments
 * fetch(id) → /gxa/json/experiments/{accession}
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

const BASE = "https://www.ebi.ac.uk/gxa"

interface GxaExperiment {
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

interface GxaExperiments {
  experiments?: GxaExperiment[]
}

/** Concatenate the searchable text of an experiment for client-side matching. */
function haystack(e: GxaExperiment): string {
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

function toHit(e: GxaExperiment): ConnectorHit {
  const accession = e.experimentAccession ?? "unknown"
  const factors = e.experimentalFactors?.length ? e.experimentalFactors.join(", ") : undefined
  const summaryBits = [e.species, e.experimentType, factors].filter((x): x is string => Boolean(x))
  return {
    id: accession,
    title: e.experimentDescription ?? accession,
    summary: summaryBits.join(" · ") || undefined,
    url: `${BASE}/experiments/${encodeURIComponent(accession)}`,
    extra: { ...e },
  }
}

async function catalogue(signal?: AbortSignal): Promise<GxaExperiment[]> {
  const data = await getJSON<GxaExperiments>(`${BASE}/json/experiments`, { signal }).catch(() => ({}) as GxaExperiments)
  return data.experiments ?? []
}

export const expressionAtlas: Connector = {
  id: "expression-atlas",
  name: "Expression Atlas",
  domain: "genomics",
  description: "Bulk gene & protein expression across tissues, conditions, and species (EMBL-EBI GXA).",
  homepage: "https://www.ebi.ac.uk/gxa",

  async search(query, opts) {
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const needle = query.trim().toLowerCase()
    const experiments = await catalogue(opts?.signal)
    const matched = needle ? experiments.filter((e) => haystack(e).includes(needle)) : experiments
    return matched.slice(0, limit).map(toHit)
  },

  async fetch(id, opts) {
    const accession = id.trim()
    const record = await getJSON(`${BASE}/json/experiments/${encodeURIComponent(accession)}`, {
      signal: opts?.signal,
    }).catch(() => undefined)
    if (record) return record
    // Fallback: return the catalogue entry if the detail endpoint is unavailable.
    const experiments = await catalogue(opts?.signal)
    return experiments.find((e) => e.experimentAccession === accession) ?? { id: accession, found: false }
  },
}
