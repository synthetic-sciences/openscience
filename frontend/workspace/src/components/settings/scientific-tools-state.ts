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
  current_availability: { local: CapabilityAvailability; hosted: CapabilityAvailability }
  basis: string
  source: { kind: string; name: string; version: string; reference: string; license?: string }
  runtime?: {
    pack_id: string
    python: string
    image: string
    lock_digest: string
    packages: string[]
    targets?: Array<"local" | "modal">
  }
  hosted?: {
    kind: "nvidia_nim"
    adapter_id: string
    credential: "nvidia_nim"
    docs_url: string
    terms_url: string
  }
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

export interface ScientificToolSetupResult {
  capability: string
  state: "ready"
  environment: string
  python: string
  packages: Record<string, string>
  lock_digest: string
  conda_lock_sha256: string
}

export type ScientificCapabilityTarget = "local" | "nvidia" | "modal"

const usable = (availability: CapabilityAvailability) =>
  availability !== "unavailable" && availability !== "not_applicable"

/**
 * Resolve only real execution paths. Inventory-only entries deliberately have
 * neither a runtime nor a hosted adapter and must never leak into the product
 * catalog merely because their manifest contains setup prose.
 */
export function scientificCapabilityTarget(record: ScientificCapabilityRecord): ScientificCapabilityTarget | undefined {
  if (record.maturity === "blocked") return
  if (record.runtime && usable(record.current_availability.local)) return "local"
  if (record.hosted && usable(record.current_availability.hosted)) return "nvidia"
  if (record.runtime?.targets?.includes("modal") && usable(record.current_availability.hosted)) return "modal"
}

export function actionableScientificCapabilities(records: ScientificCapabilityRecord[]) {
  return records.filter((record) => scientificCapabilityTarget(record) !== undefined)
}

export function capabilityState(record: ScientificCapabilityRecord) {
  const target = scientificCapabilityTarget(record)
  if (!target) return { label: "Unavailable", tone: "danger" as const, action: undefined }
  const availability = target === "local" ? record.current_availability.local : record.current_availability.hosted
  if (availability === "degraded")
    return {
      label: "Needs attention",
      tone: "warning" as const,
      action:
        target === "local" ? ("setup" as const) : target === "nvidia" ? ("credentials" as const) : ("compute" as const),
    }
  if (availability === "ready" || availability === "configured")
    return { label: "Ready", tone: "success" as const, action: undefined }
  return {
    label: target === "local" ? "Not installed" : "Setup needed",
    tone: "neutral" as const,
    action:
      target === "local" ? ("setup" as const) : target === "nvidia" ? ("credentials" as const) : ("compute" as const),
  }
}
