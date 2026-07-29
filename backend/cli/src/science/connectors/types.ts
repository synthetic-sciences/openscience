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

/**
 * Per-host politeness limits a connector can request for its HTTP calls.
 *
 * Applied per URL host by the shared http layer, so a multi-DB fan-out is never
 * over-serialized. arXiv, for example, asks for ~1 request every 3s
 * (`minIntervalMs: 3000`); keyless Semantic Scholar wants ~1000ms.
 */
export interface RateLimit {
  /** Minimum spacing between the START of requests to the same host, in ms. */
  minIntervalMs?: number
  /** Max concurrent in-flight requests to the same host. */
  maxConcurrent?: number
}

/** A record retrieved as a file rather than a structured record. */
export interface FetchedFile {
  /** File contents. Text formats only — no binary support in this increment. */
  body: string
  /** MIME type as served, e.g. "chemical/x-cif". */
  contentType: string
  /** Extension-bearing suggested name, e.g. "6LU7.cif". */
  filename: string
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
  /**
   * FILE formats this connector can serve, e.g. ["pdb", "cif"]. Absent = records only.
   * Never includes "json" — omitting `format` is the record path via `fetch()`.
   */
  formats?: string[]
  /** Retrieve a record as a file in one of `formats`. Present iff `formats` is. */
  fetchFile?(id: string, format: string, opts?: FetchOptions): Promise<FetchedFile>
}

/** Public catalog entry shape returned by the registry (no functions). */
export interface CatalogEntry {
  id: string
  name: string
  domain: ConnectorDomain
  description: string
  homepage?: string
  formats?: string[]
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
    return this.all().map(({ id, name, domain, description, homepage, formats }) => ({
      id,
      name,
      domain,
      description,
      homepage,
      formats,
    }))
  }
}
