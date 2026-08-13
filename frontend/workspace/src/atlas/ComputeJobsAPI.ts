import type { ProjectRequest } from "@/utils/openscience-fetch"

export type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"
export type Target = { kind: "local" } | { kind: "ssh"; host_id: string } | { kind: "modal" }

export interface Artifact {
  path: string
  size: number
  sha256: string
  modified_at: string
  artifact_id?: string
  version_id?: string
  version?: number
}

export interface Host {
  id: string
  label: string
  host: string
  user?: string
  port?: number
  scheduler: "none" | "slurm" | "pbs"
  workdir?: string
  notes?: string
  fingerprint?: string
  concurrency: number
}

export interface ConfigHost {
  alias: string
  hostname?: string
  user?: string
  port?: number
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
  purpose?: string
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
  cleanup_error?: string
  session_id?: string
  remote_id?: string
  lifecycle?: {
    execution: string
    delivery: string
    resource: "none" | "starting" | "active" | "closed" | "unknown"
    recoverable: boolean
    error_kind?: string
    system_hint?: string
  }
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
    volume?: string
  }
  ssh?: {
    protocol: 1
    host: Host
    root: string
    cwd: string
    fingerprint: string
    uploads: { path: string; size: number; sha256: string }[]
    upload_bytes: number
    approval: string
  }
}

export interface JobInput {
  sessionID: string
  name: string
  purpose?: string
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

export interface ModalPlan {
  digest: string
  provider: "modal"
  purpose: string
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

export interface LocalPlan {
  digest: string
  provider: "local"
  name: string
  purpose: string
  command: string
  cwd: string
  resources?: Resources
  artifact_patterns: string[]
  checkpoint?: string
  warning: string
}

export interface SshPlan {
  digest: string
  provider: "ssh"
  purpose: string
  host_id: string
  host: string
  label: string
  scheduler: "none" | "slurm" | "pbs"
  host_notes?: string
  fingerprint: string
  command: string
  local_cwd: string
  remote_root: string
  remote_cwd: string
  uploads: { path: string; size: number; sha256: string }[]
  upload_bytes: number
  outputs: string[]
  warning: string
}

export type Plan = LocalPlan | ModalPlan | SshPlan

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

export function serial<T>(run: (value: T) => Promise<void>) {
  const state: { active: boolean; pending?: T } = { active: false }
  const next = async (value: T): Promise<void> => {
    if (state.active) {
      state.pending = value
      return
    }
    state.active = true
    return run(value).finally(async () => {
      state.active = false
      const pending = state.pending
      state.pending = undefined
      if (pending !== undefined) await next(pending)
    })
  }
  return next
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
    settings: () =>
      request("/settings/compute", { cache: "no-store" }).then(async (response) => {
        if (!response.ok)
          throw new Error((await response.text().catch(() => "")) || `${response.status} ${response.statusText}`)
        return response.json() as Promise<{ ssh_hosts: Host[]; ssh_config_hosts: ConfigHost[] }>
      }),
    list: () => call<Job[]>("", { cache: "no-store" }),
    plan: (input: JobInput) => call<Plan>("/plan", { method: "POST", body: JSON.stringify(input) }),
    start: (input: JobInput) => call<Job>("", { method: "POST", body: JSON.stringify(input) }),
    log: (id: string) => call<{ log: string }>(`/${id}/log`, { cache: "no-store" }),
    events: (id: string) => call<{ events: string }>(`/${id}/events`, { cache: "no-store" }),
    retry: (id: string) => call<Job>(`/${id}/retry`, { method: "POST" }),
    release: (id: string) => call<Job>(`/${id}/release`, { method: "POST" }),
    cancel: (id: string) => call<Job>(`/${id}/cancel`, { method: "POST" }),
    clear: () => call<{ cleared: number }>("/completed", { method: "DELETE" }),
  }
}
