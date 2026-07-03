import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { asText, clampLimit, snippet } from "./util"

/** One pathway entry from the WikiPathways JSON catalog. */
interface WpPathway {
  id?: string
  name?: string
  url?: string
  species?: string
  revision?: string
  authors?: string
  description?: string
}

interface WpResponse {
  pathwayInfo?: WpPathway[]
}

// The legacy SOAP-style webservice.wikipathways.org is retired. The current
// static JSON catalog returns the FULL pathway list and ignores query params,
// so we fetch it once (cached by the shared HTTP layer) and filter locally.
const CATALOG = "https://www.wikipathways.org/json/findPathwaysByText.json"

async function catalog(signal?: AbortSignal): Promise<WpPathway[]> {
  const data = await getJSON<WpResponse>(CATALOG, { signal }).catch(() => ({}) as WpResponse)
  return Array.isArray(data.pathwayInfo) ? data.pathwayInfo : []
}

/**
 * WikiPathways — community-curated biological pathways across many species.
 * Open, no key required.
 */
export const wikipathways: Connector = {
  id: "wikipathways",
  name: "WikiPathways",
  domain: "biology",
  description: "Community-curated biological pathways across many species.",
  homepage: "https://www.wikipathways.org",

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 25)
    const needle = query.trim().toLowerCase()
    // organism is nominally a taxon id; only apply as a species-name filter
    // when it actually looks like a name (contains letters).
    const species = asText(opts?.organism)?.toLowerCase()
    const speciesFilter = species && /[a-z]/.test(species) ? species : undefined

    const rows = await catalog(opts?.signal)
    const matches = rows.filter((p) => {
      if (speciesFilter && !(p.species ?? "").toLowerCase().includes(speciesFilter)) return false
      if (!needle) return true
      const hay = `${p.name ?? ""} ${p.description ?? ""} ${p.id ?? ""}`.toLowerCase()
      return hay.includes(needle)
    })

    return matches
      .slice(0, limit)
      .map<ConnectorHit>((p) => ({
        id: p.id ?? "",
        title: p.name ?? p.id ?? "",
        summary: snippet(p.description) ?? p.species,
        url: p.url ?? (p.id ? `https://www.wikipathways.org/pathways/${p.id}` : undefined),
        extra: { ...p },
      }))
      .filter((h) => h.id)
  },

  async fetch(id, opts) {
    const rows = await catalog(opts?.signal)
    const key = id.toLowerCase()
    return rows.find((p) => (p.id ?? "").toLowerCase() === key) ?? null
  },
}
