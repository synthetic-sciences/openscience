/**
 * Genomics connectors — one uniform `Connector` per public, keyless data source.
 *
 * The default export is a flat array the integration stage registers in one call:
 *
 *   import genomicsConnectors from "./genomics"
 *   for (const c of genomicsConnectors) registry.register(c)
 *
 * Individual connectors are also re-exported by name for selective registration.
 */
import type { Connector } from "../types"
import { ensembl } from "./ensembl"
import { ncbiGene } from "./ncbi-gene"
import { dbsnp } from "./dbsnp"
import { clinvar } from "./clinvar"
import { gnomad } from "./gnomad"
import { ucsc } from "./ucsc"
import { mygene } from "./mygene"
import { myvariant } from "./myvariant"

export { ensembl, ncbiGene, dbsnp, clinvar, gnomad, ucsc, mygene, myvariant }

/** All genomics connectors, in a sensible display order. */
const genomicsConnectors: Connector[] = [ensembl, ncbiGene, dbsnp, clinvar, gnomad, ucsc, mygene, myvariant]

export default genomicsConnectors
