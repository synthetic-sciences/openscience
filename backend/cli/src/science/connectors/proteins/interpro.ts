/**
 * InterPro (and Pfam, served through the InterPro API) — protein families,
 * domains, and functional sites.
 *
 * API: https://www.ebi.ac.uk/interpro/api/entry/{db}/
 *   - db = "interpro" → integrated InterPro entries
 *   - db = "pfam"     → Pfam families/domains (a member database of InterPro)
 *
 * The `name` field is a string in list responses but an object ({name, short})
 * in single-entry responses, so it is resolved defensively.
 */
import type { Connector, ConnectorHit, FetchOptions, SearchOptions } from "../types"
import { getJSON } from "../http"
import { asArray, clampLimit, firstString, toRaw } from "./util"

interface GoTerm {
  identifier?: string
  name?: string
}
interface EntryMeta {
  accession?: string
  name?: string | { name?: string; short?: string }
  type?: string
  source_database?: string
  integrated?: string | null
  go_terms?: GoTerm[] | null
}
interface ListResult {
  metadata?: EntryMeta
}
interface ListResponse {
  count?: number
  results?: ListResult[]
}
interface EntryResponse {
  metadata?: EntryMeta
}

type Db = "interpro" | "pfam"

const API = "https://www.ebi.ac.uk/interpro/api/entry"

function resolveName(name: EntryMeta["name"], fallback: string): string {
  if (typeof name === "string") return name.trim().length ? name : fallback
  if (name && typeof name === "object") return firstString(name.name, name.short) ?? fallback
  return fallback
}

function metaSummary(m: EntryMeta): string | undefined {
  const go = asArray<GoTerm>(m.go_terms)
    .map((g) => g.name)
    .filter((n): n is string => typeof n === "string")
    .slice(0, 3)
  const parts = [
    m.type ? `Type: ${m.type}` : undefined,
    m.integrated ? `InterPro: ${m.integrated}` : undefined,
    go.length ? `GO: ${go.join(", ")}` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

function makeConnector(db: Db, meta: Omit<Connector, "search" | "fetch">): Connector {
  return {
    ...meta,
    async search(query, opts?: SearchOptions): Promise<ConnectorHit[]> {
      const size = clampLimit(opts?.limit, 10, 25)
      const url = `${API}/${db}/?search=${encodeURIComponent(query)}&page_size=${size}`
      const data = await getJSON<ListResponse>(url, { signal: opts?.signal }).catch(() => ({}) as ListResponse)
      const hits: ConnectorHit[] = []
      for (const r of asArray<ListResult>(data.results)) {
        const m = r.metadata
        const id = m?.accession
        if (typeof id !== "string") continue
        hits.push({
          id,
          title: resolveName(m?.name, id),
          summary: m ? metaSummary(m) : undefined,
          url: `https://www.ebi.ac.uk/interpro/entry/${db}/${id}/`,
          extra: toRaw(m ?? r),
        })
      }
      return hits
    },
    async fetch(id, opts?: FetchOptions): Promise<unknown> {
      return getJSON<EntryResponse>(`${API}/${db}/${encodeURIComponent(id)}`, {
        signal: opts?.signal,
      })
    },
  }
}

export const interpro: Connector = makeConnector("interpro", {
  id: "interpro",
  name: "InterPro",
  domain: "proteomics",
  description: "Integrated protein families, domains, and functional sites with GO annotations.",
  homepage: "https://www.ebi.ac.uk/interpro",
})

export const pfam: Connector = makeConnector("pfam", {
  id: "pfam",
  name: "Pfam",
  domain: "proteomics",
  description: "Pfam protein families and domains (member database of InterPro).",
  homepage: "https://www.ebi.ac.uk/interpro/entry/pfam",
})
