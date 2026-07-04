import type { Connector, ConnectorHit } from "../types"
import { getText } from "../http"
import { asText, clampLimit } from "./util"

const REST = "https://rest.kegg.jp"

/**
 * KEGG REST API — pathway maps, modules, orthologs, compounds, and reactions.
 * Responses are tab-delimited flat text, not JSON. Public, no key required.
 *
 * `search` targets the `pathway` database by default; override via
 * `opts.params.database` (e.g. "module", "ko", "compound", "genes").
 */
export const kegg: Connector = {
  id: "kegg",
  name: "KEGG",
  domain: "biology",
  description: "KEGG pathway maps, modules, orthologs, compounds, and reactions.",
  homepage: "https://www.kegg.jp",

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 50)
    const database = asText(opts?.params?.["database"]) ?? "pathway"
    const url = `${REST}/find/${encodeURIComponent(database)}/${encodeURIComponent(query)}`
    const text = await getText(url, { signal: opts?.signal }).catch(() => "")

    const hits: ConnectorHit[] = []
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const tab = trimmed.indexOf("\t")
      const rawId = (tab >= 0 ? trimmed.slice(0, tab) : trimmed).trim()
      const title = (tab >= 0 ? trimmed.slice(tab + 1) : "").trim()
      // KEGG ids can be prefixed (e.g. "path:map04210"); keep the bare accession.
      const id = rawId.includes(":") ? rawId.slice(rawId.indexOf(":") + 1) : rawId
      if (!id) continue
      hits.push({
        id,
        title: title || id,
        summary: `KEGG ${database} entry ${rawId}`,
        url: `https://www.kegg.jp/entry/${encodeURIComponent(id)}`,
        extra: { entry: rawId, database, title },
      })
      if (hits.length >= limit) break
    }
    return hits
  },

  async fetch(id, opts) {
    const url = `${REST}/get/${encodeURIComponent(id)}`
    const text = await getText(url, { signal: opts?.signal }).catch(() => "")
    return { id, format: "kegg-flat", text }
  },
}
