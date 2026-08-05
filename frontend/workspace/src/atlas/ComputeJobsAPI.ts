import type { ProjectRequest } from "@/utils/openscience-fetch"

export type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"
export type Target = { kind: "local" } | { kind: "ssh"; host_id: string } | { kind: "modal" }

export interface Artifact {
  path: string
  size: number
  sha256: string
  modified_at: string
}

export interface Resources {
  cpus?: number
  gpus?: number
  memory_gb?: number
  time_minutes?: number
  partition?: string
}

export interface Reproducibility {
  captured_at: string
  command: string
  cwd: string
  platform: string
  arch: string
  bun: string
  node: string
  python?: string
  git?: {
    branch?: string
    commit?: string
    dirty: boolean
  }
  lockfiles: Artifact[]
  resources?: Resources
}

export interface Job {
  id: string
  name: string
  command: string
  cwd?: string
  target: Target
  target_label: string
  scheduler: "none" | "slurm" | "pbs"
  status: Status
  created_at: string
  started_at?: string
  completed_at?: string
  exit_code?: number | null
  error?: string
  resources?: Resources
  modules?: string[]
  container?: string
  artifact_patterns?: string[]
  artifacts?: Artifact[]
  checkpoint_path?: string
  checkpoint?: Artifact
  reproducibility?: Reproducibility
  capture_error?: string
  remote_id?: string
  modal?: {
    app: string
    image: string
    gpu: string
    network: "unrestricted" | "none"
    timeout_minutes: number
    uploads: { path: string; size: number; sha256: string }[]
    upload_bytes: number
    approval: string
    sdk: string
  }
}

export interface JobInput {
  sessionID: string
  name: string
  command: string
  cwd?: string
  target: Target
  resources?: Resources
  modules?: string[]
  container?: string
  artifacts?: string[]
  checkpoint?: string
  uploads?: string[]
  image?: string
  gpu?: string
  approval?: string
}

export interface Plan {
  digest: string
  provider: "modal"
  app: string
  image: string
  gpu: string
  timeout_minutes: number
  network: "unrestricted" | "none"
  command: string
  cwd: string
  uploads: { path: string; size: number; sha256: string }[]
  upload_bytes: number
  outputs: string[]
  warning: string
}

export function stableJobs(previous: Job[] | undefined, next: Job[]) {
  if (!previous) return next
  const index = new Map(previous.map((job) => [job.id, job]))
  const jobs = next.map((job) => {
    const current = index.get(job.id)
    if (!current) return job
    return JSON.stringify(current) === JSON.stringify(job) ? current : job
  })
  if (previous.length === jobs.length && previous.every((job, position) => job === jobs[position])) return previous
  return jobs
}

export function createComputeJobsAPI(request: ProjectRequest) {
  const call = async <T>(path: string, init?: RequestInit) => {
    const response = await request(`/settings/compute/jobs${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(detail || `${response.status} ${response.statusText}`)
    }
    if (response.status === 204) return undefined as T
    const content = response.headers.get("content-type") ?? ""
    if (!content.includes("application/json")) {
      throw new Error(`Expected JSON from compute jobs, but got ${response.status} (${content || "no content-type"})`)
    }
    return response.json() as Promise<T>
  }
  return {
    list: () => call<Job[]>(""),
    plan: (input: JobInput) => call<Plan>("/plan", { method: "POST", body: JSON.stringify(input) }),
    start: (input: JobInput) => call<Job>("", { method: "POST", body: JSON.stringify(input) }),
    log: (id: string) => call<{ log: string }>(`/${id}/log`),
    events: (id: string) => call<{ events: string }>(`/${id}/events`),
    cancel: (id: string) => call<Job>(`/${id}/cancel`, { method: "POST" }),
    clear: () => call<{ cleared: number }>("/completed", { method: "DELETE" }),
  }
}
