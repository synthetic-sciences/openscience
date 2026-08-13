type RequestTransport = (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>

export type Captured<T> = { status: "available"; value: T } | { status: "unavailable"; reason: string }

export interface ExecutionFile {
  path: string
  sha256: string
  size: number
}

export interface ExecutionArtifact {
  id: string
  label: string
  kind: string
  sha256?: string
  size?: number
  artifact_id?: string
  version_id?: string
}

export interface ExecutionRecord {
  id: string
  session_id: string
  sequence: number
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "inconclusive"
  language: string
  code: Captured<string>
  environment: {
    name: Captured<string>
    interpreter: Captured<{
      name: string
      binary: string
      version: Captured<string>
    }>
    kernel_id: Captured<string>
    incarnation: Captured<number>
    restart_boundary: boolean
  }
  timing: {
    created_at: Captured<string>
    started_at: Captured<string>
    completed_at: Captured<string>
    duration_ms: Captured<number>
  }
  result: {
    summary: string
    stdout: string
    stderr: string
    error: string
    output_count: number
  }
  resources: Captured<{
    cpu_percent?: number
    memory_bytes?: number
    gpu_percent?: number
    vram_bytes?: number
  }>
  files: ExecutionFile[]
  artifacts: ExecutionArtifact[]
  provenance_id: string | null
  message_id?: string
  call_id?: string
}

export function captured<T>(field: Captured<T> | undefined) {
  return field?.status === "available" ? field.value : undefined
}

export function executionTime(run: ExecutionRecord) {
  const raw = captured(run.timing.completed_at) ?? captured(run.timing.started_at) ?? captured(run.timing.created_at)
  const time = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

export function recentExecutions(runs: readonly ExecutionRecord[], limit = 12) {
  return [...runs]
    .sort((left, right) => executionTime(right) - executionTime(left) || right.sequence - left.sequence)
    .slice(0, limit)
}

function isLegacyHistoryMiss(response: Response, detail: string) {
  if (response.status !== 404) return false
  try {
    const body = JSON.parse(detail) as { error?: unknown }
    return body.error === "Provenance node not found"
  } catch {
    return false
  }
}

export function createExecutionHistoryAPI(request: RequestTransport) {
  let available: boolean | undefined
  return {
    async list(sessionID: string) {
      if (available === false) return []
      const query = new URLSearchParams({ sessionID })
      const response = await request(`/provenance/executions?${query.toString()}`, { cache: "no-store" })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        // Servers from before durable execution history route this literal
        // path through `/provenance/:id`. Missing node `executions` means the
        // optional history source does not exist in that server generation;
        // live kernels and commands remain authoritative and usable.
        if (isLegacyHistoryMiss(response, detail)) {
          available = false
          return []
        }
        throw new Error(detail || `${response.status} ${response.statusText}`)
      }
      available = true
      return response.json() as Promise<ExecutionRecord[]>
    },
  }
}
