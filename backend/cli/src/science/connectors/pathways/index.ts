/**
 * Pathways & molecular-interaction connectors.
 *
 * One connector per public, key-free scientific data source covering biological
 * pathways and interaction networks. The integration stage imports the single
 * `pathwayConnectors` array below and registers each entry on the shared
 * `ConnectorRegistry` — feature agents add sources here without touching the
 * shared `connectors/index.ts`.
 */
import type { Connector } from "../types"
import { biosimulators } from "./biosimulators"
import { reactome } from "./reactome"
import { kegg } from "./kegg"
import { stringdb } from "./string-db"
import { biogrid } from "./biogrid"
import { intact } from "./intact"
import { wikipathways } from "./wikipathways"
import { opentargets } from "./opentargets"

/** All pathway/interaction connectors in this batch, in catalog order. */
const pathwayConnectors: Connector[] = [
  biosimulators,
  reactome,
  kegg,
  stringdb,
  biogrid,
  intact,
  wikipathways,
  opentargets,
]

export { biosimulators, reactome, kegg, stringdb, biogrid, intact, wikipathways, opentargets }

export default pathwayConnectors
