export type ArtifactCaptureQuality = "exact" | "declared" | "partial" | "unknown"

export interface StoredArtifactVersion {
  id: string
  artifactID: string
  version: number
  filename: string
  mimeType: string
  size: number
  sha256: string
  sessionID: string
  messageID?: string
  executionID?: string
  sourcePath: string
  captureQuality: ArtifactCaptureQuality
  createdAt: number
}

export interface StoredArtifact {
  schemaVersion: 1
  id: string
  projectID: string
  title: string
  kind: string
  currentVersionID: string
  createdAt: number
  updatedAt: number
  state: "active" | "trash"
  trashedAt?: number
  versionCount: number
  current: StoredArtifactVersion
}

export interface StoredArtifactExecution {
  id: string
  artifactVersionID: string
  command?: string
  code?: string
  status: "succeeded" | "failed" | "cancelled" | "unknown"
  stdout?: string
  stderr?: string
  model?: string
  provider?: string
  effort?: string
  source?: string
  permissionSnapshot?: Record<string, unknown>
  inputs?: Record<string, unknown>
  captureQuality: ArtifactCaptureQuality
  files: Array<{ path: string; sha256: string; size: number }>
  environment?: Record<string, unknown>
  createdAt: number
}

export interface StoredArtifactDetail extends StoredArtifact {
  versions: StoredArtifactVersion[]
  execution?: StoredArtifactExecution
}

/** Compact, path-safe copy for save confirmations. */
export function savedResultLabel(artifact: Pick<StoredArtifact, "current">) {
  const filename = artifact.current.filename.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "Result"
  return `${filename} · Version ${artifact.current.version}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function quality(value: unknown): value is ArtifactCaptureQuality {
  return value === "exact" || value === "declared" || value === "partial" || value === "unknown"
}

export function normalizeStoredArtifactVersion(value: unknown): StoredArtifactVersion | undefined {
  const row = record(value)
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.artifactID !== "string" ||
    typeof row.version !== "number" ||
    typeof row.filename !== "string" ||
    typeof row.mimeType !== "string" ||
    typeof row.size !== "number" ||
    typeof row.sha256 !== "string" ||
    typeof row.sessionID !== "string" ||
    typeof row.sourcePath !== "string" ||
    !quality(row.captureQuality) ||
    typeof row.createdAt !== "number"
  )
    return
  return {
    id: row.id,
    artifactID: row.artifactID,
    version: row.version,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    sha256: row.sha256,
    sessionID: row.sessionID,
    ...(typeof row.messageID === "string" ? { messageID: row.messageID } : {}),
    ...(typeof row.executionID === "string" ? { executionID: row.executionID } : {}),
    sourcePath: row.sourcePath,
    captureQuality: row.captureQuality,
    createdAt: row.createdAt,
  }
}

export function storedArtifactReviewTargetID(version: Pick<StoredArtifactVersion, "id" | "sha256">) {
  return `artifact-version:${version.id}:${version.sha256.slice(0, 16)}`
}

export function normalizeStoredArtifact(value: unknown): StoredArtifact | undefined {
  const row = record(value)
  const current = normalizeStoredArtifactVersion(row?.current)
  if (
    !row ||
    row.schemaVersion !== 1 ||
    typeof row.id !== "string" ||
    typeof row.projectID !== "string" ||
    typeof row.title !== "string" ||
    typeof row.kind !== "string" ||
    typeof row.currentVersionID !== "string" ||
    typeof row.createdAt !== "number" ||
    typeof row.updatedAt !== "number" ||
    (row.state !== "active" && row.state !== "trash") ||
    typeof row.versionCount !== "number" ||
    !current
  )
    return
  return {
    schemaVersion: 1,
    id: row.id,
    projectID: row.projectID,
    title: row.title,
    kind: row.kind,
    currentVersionID: row.currentVersionID,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    state: row.state,
    ...(typeof row.trashedAt === "number" ? { trashedAt: row.trashedAt } : {}),
    versionCount: row.versionCount,
    current,
  }
}

export function normalizeStoredArtifacts(value: unknown): StoredArtifact[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const artifact = normalizeStoredArtifact(item)
    return artifact ? [artifact] : []
  })
}

export function normalizeStoredArtifactDetail(value: unknown): StoredArtifactDetail | undefined {
  const artifact = normalizeStoredArtifact(value)
  const row = record(value)
  if (!artifact || !row || !Array.isArray(row.versions)) return
  const versions = row.versions.flatMap((item) => {
    const version = normalizeStoredArtifactVersion(item)
    return version ? [version] : []
  })
  if (!versions.length) return
  return { ...artifact, versions }
}
