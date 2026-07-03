import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"
import { clampLimit, snippet } from "./util"

/** A hit from the Open Targets `search` query. */
interface OtHit {
  id?: string
  name?: string
  entity?: string
  description?: string
}

interface OtSearchResponse {
  data?: { search?: { hits?: OtHit[] } }
}

const ENDPOINT = "https://api.platform.opentargets.org/api/v4/graphql"

const SEARCH_QUERY = `query Search($q: String!, $size: Int!) {
  search(queryString: $q, entityNames: ["target", "disease", "drug"], page: { index: 0, size: $size }) {
    hits { id name entity description }
  }
}`

// A single id is resolved against all three entity roots; non-matching roots
// return null (GraphQL does not error), so one round-trip covers every case.
const FETCH_QUERY = `query Fetch($id: String!) {
  target(ensemblId: $id) { id approvedSymbol approvedName biotype }
  disease(efoId: $id) { id name description }
  drug(chemblId: $id) { id name drugType }
}`

async function graphql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T | null> {
  return getJSON<T>(ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
    headers: { "Content-Type": "application/json" },
    signal,
  }).catch(() => null)
}

function entityUrl(hit: OtHit): string | undefined {
  if (!hit.id) return undefined
  if (hit.entity === "disease") return `https://platform.opentargets.org/disease/${hit.id}`
  if (hit.entity === "drug") return `https://platform.opentargets.org/drug/${hit.id}`
  return `https://platform.opentargets.org/target/${hit.id}`
}

/**
 * Open Targets Platform GraphQL API — target / disease / drug associations for
 * drug-target identification. Open, no key required.
 */
export const opentargets: Connector = {
  id: "opentargets",
  name: "Open Targets",
  domain: "genomics",
  description: "Target-disease-drug associations for drug target identification.",
  homepage: "https://platform.opentargets.org",

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 25)
    const res = await graphql<OtSearchResponse>(SEARCH_QUERY, { q: query, size: limit }, opts?.signal)
    const hits = res?.data?.search?.hits ?? []
    return hits
      .slice(0, limit)
      .map<ConnectorHit>((h) => ({
        id: h.id ?? "",
        title: h.name ?? h.id ?? "",
        summary: snippet(h.description) ?? h.entity,
        url: entityUrl(h),
        extra: { ...h },
      }))
      .filter((h) => h.id)
  },

  async fetch(id, opts) {
    const res = await graphql<{ data?: Record<string, unknown> }>(FETCH_QUERY, { id }, opts?.signal)
    const data = res?.data ?? {}
    return data["target"] ?? data["disease"] ?? data["drug"] ?? null
  },
}
