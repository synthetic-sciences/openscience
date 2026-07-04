/**
 * Chemistry connector bundle.
 *
 * Each file in this folder wraps ONE public, keyless chemical database behind the
 * shared `Connector` contract (`../types`). The integration stage imports this
 * default array and registers every entry against the shared registry — nothing
 * here edits the shared `connectors/index.ts`.
 */
import type { Connector } from "../types"
import { chembl } from "./chembl"
import { pubchem } from "./pubchem"
import { bindingdb } from "./bindingdb"
import { gtopdb } from "./gtopdb"
import { surechembl } from "./surechembl"
import { chebi } from "./chebi"

export { chembl, pubchem, bindingdb, gtopdb, surechembl, chebi }

/** All chemistry-domain connectors, ready to register. */
const chemistryConnectors: Connector[] = [chembl, pubchem, bindingdb, gtopdb, surechembl, chebi]

export default chemistryConnectors
