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
  availability: { local: CapabilityAvailability; hosted: CapabilityAvailability }
  current_availability: { local: CapabilityAvailability; hosted: CapabilityAvailability }
  basis: string
  source: { kind: string; name: string; version: string; reference: string; license?: string }
  runtime?: { pack_id: string; python: string; image: string; lock_digest: string; packages: string[] }
  hosted?: { kind: "nvidia_nim"; adapter_id: string; docs_url: string; terms_url: string }
  setup?: { instructions: string; requirements: string[] }
  blocker?: string
}

export interface CapabilityEvidenceRecord {
  capability: {
    id: string
    version: string
    manifest_sha256: string
    profile: "smoke"
    runtime_digest: string
  }
  target: "local" | "modal"
  job_id: string
  app_version: string
  verified_at: string
  metrics: Record<string, string | number | boolean>
  artifacts: Array<{ path: string; size: number; sha256: string }>
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
  evidence: Record<string, CapabilityEvidenceRecord>
  connectors: ConnectorCatalogRecord[]
  counts: { total: number; packaged: number; hosted: number; verified: number; experimental: number; blocked: number }
}

export type ScientificToolFilter = "all" | "packaged" | "hosted" | "setup" | "blocked"

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
    if (filter === "hosted") return Boolean(record.hosted)
    if (filter === "setup")
      return (
        record.current_availability.local === "setup_needed" || record.current_availability.hosted === "setup_needed"
      )
    if (filter === "blocked") return record.maturity === "blocked"
    return true
  })
}

export function capabilityState(record: ScientificCapabilityRecord, evidence: CapabilityEvidenceRecord[]) {
  if (record.maturity === "blocked") return { label: "Blocked", tone: "danger" as const }
  if (record.maturity === "verified") return { label: "Release verified", tone: "success" as const }
  if (evidence.length) return { label: "Smoke recorded · experimental", tone: "warning" as const }
  if (record.current_availability.local === "degraded" || record.current_availability.hosted === "degraded")
    return { label: "Degraded · experimental", tone: "danger" as const }
  if (record.current_availability.local === "ready" && record.current_availability.hosted === "ready")
    return { label: "Ready local + hosted · experimental", tone: "warning" as const }
  if (record.current_availability.local === "ready")
    return { label: "Ready locally · experimental", tone: "warning" as const }
  if (record.current_availability.hosted === "ready")
    return { label: "Ready hosted · experimental", tone: "warning" as const }
  if (record.current_availability.hosted === "configured")
    return { label: "Credential configured · not live-tested", tone: "warning" as const }
  if (record.runtime) return { label: "Packaged · experimental", tone: "warning" as const }
  if (record.hosted) return { label: "Hosted preview", tone: "warning" as const }
  return { label: "Setup needed", tone: "neutral" as const }
}
