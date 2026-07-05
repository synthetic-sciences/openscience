/**
 * ArrayExpress / BioStudies connector.
 *
 * ArrayExpress functional-genomics experiments are hosted on EMBL-EBI's
 * BioStudies platform. This connector searches the `arrayexpress` collection
 * and fetches full study records via the public BioStudies REST API. No key.
 *
 * search()  → /biostudies/api/v1/arrayexpress/search
 * fetch(id) → /biostudies/api/v1/studies/{accession}  (full study JSON)
 */
import type { Connector, ConnectorHit } from "../types"
import { getJSON } from "../http"

const BASE = "https://www.ebi.ac.uk/biostudies/api/v1"

interface BioStudiesHit {
  accession?: string
  type?: string
  title?: string
  author?: string
  content?: string
  release_date?: string
  links?: number
  files?: number
  views?: number
  isPublic?: boolean
}

interface BioStudiesSearch {
  totalHits?: number
  hits?: BioStudiesHit[]
}

function studyUrl(accession: string): string {
  return `https://www.ebi.ac.uk/biostudies/arrayexpress/studies/${encodeURIComponent(accession)}`
}

function toHit(h: BioStudiesHit): ConnectorHit {
  const accession = h.accession ?? "unknown"
  const summaryBits = [h.author, h.release_date].filter((x): x is string => Boolean(x))
  return {
    id: accession,
    title: h.title ?? accession,
    summary: h.content ? h.content.trim().slice(0, 400) : summaryBits.join(" · ") || undefined,
    url: studyUrl(accession),
    extra: { ...h },
  }
}

export const arrayexpress: Connector = {
  id: "arrayexpress",
  name: "ArrayExpress / BioStudies",
  domain: "genomics",
  description: "Functional genomics experiments (microarray & sequencing) archived on EMBL-EBI BioStudies.",
  homepage: "https://www.ebi.ac.uk/biostudies/arrayexpress",

  async search(query, opts) {
    const size = Math.min(Math.max(opts?.limit ?? 10, 1), 25)
    const url = `${BASE}/arrayexpress/search?query=${encodeURIComponent(query)}&pageSize=${size}`
    const data = await getJSON<BioStudiesSearch>(url, { signal: opts?.signal }).catch(() => ({}) as BioStudiesSearch)
    return (data.hits ?? []).map(toHit)
  },

  async fetch(id, opts) {
    const accession = id.trim()
    return getJSON(`${BASE}/studies/${encodeURIComponent(accession)}`, {
      signal: opts?.signal,
    }).catch(() => ({ accession, found: false }))
  },
}
