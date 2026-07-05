/**
 * UniProt — the reference protein sequence & functional annotation database.
 *
 * REST API: https://rest.uniprot.org (open, no key). We hit the UniProtKB
 * search + entry endpoints and normalize into ConnectorHit.
 */
import type { Connector, ConnectorHit, FetchOptions, SearchOptions } from "../types"
import { getJSON, getText } from "../http"
import { asArray, clampLimit, firstString, toRaw } from "./util"

interface UValue {
  value?: string
}
interface UName {
  fullName?: UValue
}
interface UDescription {
  recommendedName?: UName
  submissionNames?: UName[]
  alternativeNames?: UName[]
}
interface UComment {
  commentType?: string
  texts?: UValue[]
}
interface UOrganism {
  scientificName?: string
  commonName?: string
  taxonId?: number
}
interface UEntry {
  primaryAccession?: string
  uniProtkbId?: string
  proteinDescription?: UDescription
  comments?: UComment[]
  organism?: UOrganism
  annotationScore?: number
}
interface USearch {
  results?: UEntry[]
}

function entryTitle(e: UEntry): string {
  const d = e.proteinDescription
  return (
    firstString(
      d?.recommendedName?.fullName?.value,
      d?.submissionNames?.[0]?.fullName?.value,
      d?.alternativeNames?.[0]?.fullName?.value,
      e.uniProtkbId,
      e.primaryAccession,
    ) ?? "Unknown protein"
  )
}

function entrySummary(e: UEntry): string | undefined {
  const fn = asArray<UComment>(e.comments).find((c) => c.commentType === "FUNCTION")
  const org = e.organism?.scientificName
  return firstString(fn?.texts?.[0]?.value, org ? `Organism: ${org}` : undefined)
}

export const uniprot: Connector = {
  id: "uniprot",
  name: "UniProt",
  domain: "proteomics",
  description: "Protein sequences with function, GO terms, domains, and pathways (UniProtKB).",
  homepage: "https://www.uniprot.org",

  async search(query, opts?: SearchOptions): Promise<ConnectorHit[]> {
    const size = clampLimit(opts?.limit, 10, 25)
    const org = opts?.organism ? ` AND organism_id:${encodeURIComponent(opts.organism)}` : ""
    const url =
      `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}${org}` + `&format=json&size=${size}`
    const data = await getJSON<USearch>(url, { signal: opts?.signal }).catch(() => ({}) as USearch)
    return asArray<UEntry>(data.results).map<ConnectorHit>((e) => {
      const id = e.primaryAccession ?? e.uniProtkbId ?? "unknown"
      return {
        id,
        title: entryTitle(e),
        summary: entrySummary(e),
        url: `https://www.uniprot.org/uniprotkb/${id}`,
        score: e.annotationScore,
        extra: toRaw(e),
      }
    })
  },

  async fetch(id, opts?: FetchOptions): Promise<unknown> {
    const format = opts?.format ?? "json"
    const base = `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(id)}`
    if (format === "json") return getJSON(`${base}?format=json`, { signal: opts?.signal })
    return getText(`${base}?format=${encodeURIComponent(format)}`, { signal: opts?.signal })
  },
}
