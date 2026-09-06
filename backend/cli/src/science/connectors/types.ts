import type { CatalogEntry, Connector, ConnectorDomain } from "@synsci/plugin"

export type {
  CatalogEntry,
  Connector,
  ConnectorDomain,
  ConnectorHit,
  SearchOptions,
  FetchOptions,
  RateLimit,
  FetchedFile,
} from "@synsci/plugin"

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
