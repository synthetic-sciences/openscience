/**
 * Literature connectors — scholarly / preprint databases.
 *
 * Each connector wraps ONE public, key-free scholarly API behind the shared
 * `Connector` contract. The integration stage imports the default array below
 * and registers every entry with the shared `ConnectorRegistry` (see the
 * `// AUTO:` marker in `../index.ts`) — this folder does not touch shared files.
 */
import type { Connector } from "../types"
import { pubmed } from "./pubmed"
import { europepmc } from "./europepmc"
import { biorxiv } from "./biorxiv"
import { crossref } from "./crossref"
import { openalex } from "./openalex"
import { semanticScholar } from "./semantic-scholar"
import { arxiv } from "./arxiv"

export { pubmed, europepmc, biorxiv, crossref, openalex, semanticScholar, arxiv }

/** All literature connectors, ready for the integration stage to register. */
const connectors: Connector[] = [pubmed, europepmc, biorxiv, crossref, openalex, semanticScholar, arxiv]

export default connectors
