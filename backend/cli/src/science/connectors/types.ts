/**
 * Shared connector framework for scientific databases.
 *
 * A Connector is a thin, uniform wrapper over a single external scientific data
 * source (UniProt, PDB, ChEMBL, arXiv, GenBank, ...). Feature agents implement
 * ONE connector per source in `./impl/<id>.ts` and register it in `./index.ts`.
 *
 * The design goal: the `science_search` / `science_list_dbs` agent tools and the
 * frontend never learn about individual databases — they route purely through
 * this registry.
 */

/** Broad scientific domain a connector belongs to. Used for grouping + filtering. */
export type ConnectorDomain =
  | "biology"
  | "chemistry"
  | "physics"
  | "genomics"
  | "proteomics"
  | "structure"
  | "literature"
  | "materials"
  | "clinical"
  | "general"

/** A single normalized search result from a connector. */
export interface ConnectorHit {
  /** Stable identifier within the source (accession, DOI, PDB id, ...). */
  id: string
  /** Human-readable title / name of the record. */
  title: string
  /** Short summary or abstract snippet. */
  summary?: string
  /** Canonical URL to the record on the source's site. */
  url?: string
  /** Relevance score if the source provides one (0-1 or source-native). */
  score?: number
  /** Source-specific structured fields, passed through verbatim. */
  extra?: Record<string, unknown>
}

/** Options accepted by `search`. Connectors ignore fields they don't support. */
export interface SearchOptions {
  /** Max hits to return. Connectors clamp to their own ceiling. */
  limit?: number
  /** Organism / taxon filter where meaningful (e.g. NCBI taxon id). */
  organism?: string
  /** Free-form per-source knobs. */
  params?: Record<string, unknown>
  /** Abort signal wired through from the tool context. */
  signal?: AbortSignal
}

/** Options accepted by `fetch`. */
export interface FetchOptions {
  /** Desired representation, e.g. "json" | "pdb" | "fasta" | "sdf". */
  format?: string
  params?: Record<string, unknown>
  signal?: AbortSignal
}

/** The uniform contract every scientific data source implements. */
export interface Connector {
  /** Unique, stable, lowercase id used to route (e.g. "uniprot", "rcsb-pdb"). */
  id: string
  /** Display name (e.g. "UniProt", "RCSB PDB"). */
  name: string
  /** Primary domain for grouping in the catalog. */
  domain: ConnectorDomain
  /** One-line description shown in `science_list_dbs`. */
  description: string
  /** Homepage / docs URL. */
  homepage?: string
  /** Search the source; returns normalized hits. */
  search(query: string, opts?: SearchOptions): Promise<ConnectorHit[]>
  /** Fetch a single record by id. Return shape is source-specific. */
  fetch(id: string, opts?: FetchOptions): Promise<unknown>
}

/** Public catalog entry shape returned by the registry (no functions). */
export interface CatalogEntry {
  id: string
  name: string
  domain: ConnectorDomain
  description: string
  homepage?: string
}

/**
 * In-memory registry of connectors. A single shared instance lives in
 * `./index.ts`; feature agents call `.register()` there.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Connector "${connector.id}" is already registered`)
    }
    this.connectors.set(connector.id, connector)
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id)
  }

  has(id: string): boolean {
    return this.connectors.has(id)
  }

  all(): Connector[] {
    return [...this.connectors.values()]
  }

  byDomain(domain: ConnectorDomain): Connector[] {
    return this.all().filter((c) => c.domain === domain)
  }

  /** Serializable catalog for tools / UI (drops the search/fetch functions). */
  catalog(): CatalogEntry[] {
    return this.all().map(({ id, name, domain, description, homepage }) => ({
      id,
      name,
      domain,
      description,
      homepage,
    }))
  }
}
