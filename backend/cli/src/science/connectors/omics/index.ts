/**
 * Omics connector bundle.
 *
 * Groups every "omics" scientific database connector (gene expression,
 * functional genomics, proteomics, and cancer-dependency data) into a single
 * default array so the integration stage can register them all with one import:
 *
 *   import omicsConnectors from "./omics"
 *   for (const c of omicsConnectors) registry.register(c)
 *
 * Each connector wraps a real, public, key-free REST API. Feature agents own
 * these files; the shared `connectors/index.ts` registry is edited only by the
 * integration stage.
 */
import type { Connector } from "../types"
import { geo } from "./geo"
import { arrayexpress } from "./arrayexpress"
import { gtex } from "./gtex"
import { hpa } from "./hpa"
import { expressionAtlas } from "./expression-atlas"
import { singleCellAtlas } from "./single-cell-atlas"
import { depmap } from "./depmap"

export { geo, arrayexpress, gtex, hpa, expressionAtlas, singleCellAtlas, depmap }

/** All omics connectors, in catalogue order. */
export const omicsConnectors: Connector[] = [geo, arrayexpress, gtex, hpa, expressionAtlas, singleCellAtlas, depmap]

export default omicsConnectors
