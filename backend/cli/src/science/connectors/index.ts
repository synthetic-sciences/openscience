/**
 * The single shared connector registry instance.
 *
 * Feature agents add ONE line per source below the AUTO marker and register it.
 * Nothing else in the codebase should construct a ConnectorRegistry — the tools
 * (`science_search`, `science_list_dbs`) and any UI import `registry` from here.
 *
 * Example integration (added by the integration stage, NOT by feature agents):
 *
 *   import { uniprot } from "./impl/uniprot"
 *   ...
 *   registry.register(uniprot)
 */
import { ConnectorRegistry } from "./types"

export const registry = new ConnectorRegistry()

// ── connector imports ──────────────────────────────────────────────────────
// AUTO: connectors registered here by integration
// (feature agents: create ./impl/<id>.ts, then add an import + registry.register
//  call inside the block below during the integration stage — do NOT edit this
//  file yourself.)
import proteins from "./proteins"
import genomics from "./genomics"
import chemistry from "./chemistry"
import pathways from "./pathways"
import literature from "./literature"
import omics from "./omics"

for (const c of [...proteins, ...genomics, ...chemistry, ...pathways, ...literature, ...omics]) {
  registry.register(c)
}
// ────────────────────────────────────────────────────────────────────────────

export * from "./types"
export * as http from "./http"
