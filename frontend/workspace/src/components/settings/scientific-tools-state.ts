export type CapabilityMaturity = "verified" | "experimental" | "blocked"
export type CapabilityAvailability =
  | "ready"
  | "configured"
  | "setup_needed"
  | "degraded"
  | "unavailable"
  | "not_applicable"

export interface ScientificCapabilityRecord {
  schema_version: 2
  id: string
  version: string
  name: string
  category: string
  summary: string
  maturity: CapabilityMaturity
  current_availability: { local: CapabilityAvailability }
  basis: string
  source: { kind: string; name: string; version: string; reference: string; license?: string }
  runtime?: { pack_id: string; python: string; image: string; lock_digest: string; packages: string[] }
  setup?: { instructions: string; requirements: string[] }
  blocker?: string
}

export interface ConnectorCatalogRecord {
  id: "github" | "benchling" | "box" | "dropbox" | "s3" | "givemeanode"
  name: string
  provider: string
  recommended: boolean
  status: "official_setup" | "manual_review" | "unavailable"
  summary: string
  source_url: string
  reviewed_at: string
  read_operations: string[]
  upstream_write_operations: string[]
  writes_enabled_by_catalog: false
  safety: string
  requirements: string[]
  revision: string
  setup?: {
    type: "remote"
    name: string
    url: string
    oauth: "auto" | "client"
    scope?: string
    confidential_client?: boolean
    one_click_disabled?: boolean
    one_click_connect?: boolean
  }
}

export interface ScientificToolsResponse {
  schema_version: 1
  capabilities: ScientificCapabilityRecord[]
  connectors: ConnectorCatalogRecord[]
}

export type ScientificToolFilter = "all" | "packaged" | "setup" | "blocked"

export function filterScientificCapabilities(
  records: ScientificCapabilityRecord[],
  query: string,
  filter: ScientificToolFilter,
) {
  const needle = query.trim().toLowerCase()
  return records.filter((record) => {
    const matches =
      !needle ||
      [record.id, record.name, record.category, record.summary, record.source.name].some((value) =>
        value.toLowerCase().includes(needle),
      )
    if (!matches) return false
    if (filter === "packaged") return Boolean(record.runtime)
    if (filter === "setup") return record.current_availability.local === "setup_needed"
    if (filter === "blocked")
      return record.maturity === "blocked" || record.current_availability.local === "unavailable"
    return true
  })
}

export function capabilityState(record: ScientificCapabilityRecord) {
  if (record.maturity === "blocked" || record.current_availability.local === "unavailable")
    return { label: "Unavailable", tone: "danger" as const }
  if (record.current_availability.local === "degraded") return { label: "Needs attention", tone: "warning" as const }
  if (record.current_availability.local === "ready" || record.current_availability.local === "configured")
    return { label: "Ready", tone: "success" as const }
  if (record.runtime) return { label: "Available", tone: "neutral" as const }
  return { label: "Setup needed", tone: "neutral" as const }
}
