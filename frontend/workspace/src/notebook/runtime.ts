export type KernelState = "lazy" | "starting" | "idle" | "running" | "stopped" | "crashed"

export type KernelEnvironment = {
  cwd: string
  atlas: {
    access: "host_broker"
    credentials: "withheld"
    sources: "source_ids_only"
  }
  sandbox: {
    requested: boolean
    enforced: boolean
    backend: "seatbelt" | "bubblewrap" | "none"
    network: "allow" | "deny"
    platform: string
    available: boolean
    tool?: string
    reason?: string
    warning?: string
  }
}

export type KernelResources = {
  cpu_percent?: number
  memory_bytes?: number
  gpu_percent?: number
  vram_bytes?: number
}

export type ExecutionAuthority = {
  allowed: boolean
  reason: "allowed" | "project_untrusted" | "sandbox_unavailable"
  mode: "read_only" | "sandboxed" | "host"
  trustRevision: number
  grantRevision: number
  generation: string
}

export type KernelStatus = {
  id: string
  active: boolean
  state: KernelState
  projectID: string
  sessionID: string
  name: string
  language: string
  target: {
    kind: "local"
  }
  incarnation: number | null
  execution_count: number
  queue_depth: number
  environment: KernelEnvironment | null
  process_id: number | null
  process_started_at: number | null
  process_identity_verified: boolean | null
  started_at: number | null
  last_activity_at: number | null
  authority?: ExecutionAuthority | null
  // Live usage sampled by the server at request time. Absent fields mean the
  // platform could not report them — render "Unavailable", never 0.
  resources?: KernelResources
}

export type KernelTone = "ready" | "active" | "pending" | "danger" | "muted"

const sessionID = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const response = value as Record<string, unknown>
  const data =
    response.data && typeof response.data === "object" && !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : response
  const id = data.id ?? data.sessionID
  return typeof id === "string" && id.length > 0 ? id : undefined
}

export async function resolveNotebookSession(routeID: string | undefined, create: () => Promise<unknown>) {
  if (routeID && routeID !== "new") return routeID
  const id = sessionID(await create())
  if (!id) throw new Error("session.create returned no id")
  return id
}

export function kernelLabel(kernel: KernelStatus) {
  if (kernel.name.startsWith("notebook:")) return kernel.name.slice("notebook:".length)
  if (kernel.name === "agent") return `${kernel.language === "r" ? "R" : "Python"} analysis`
  return kernel.name
}

export function kernelTone(state: KernelState): KernelTone {
  if (state === "idle") return "ready"
  if (state === "running") return "active"
  if (state === "starting") return "pending"
  if (state === "crashed") return "danger"
  return "muted"
}

export function kernelStateLabel(state: KernelState) {
  if (state === "lazy") return "Not started"
  if (state === "idle") return "Ready"
  return state.charAt(0).toUpperCase() + state.slice(1)
}

export function summarizeKernels(kernels: KernelStatus[]) {
  return kernels.reduce(
    (summary, kernel) => ({
      live: summary.live + (kernel.active ? 1 : 0),
      running: summary.running + (kernel.state === "running" ? 1 : 0),
      queued: summary.queued + kernel.queue_depth,
    }),
    { live: 0, running: 0, queued: 0 },
  )
}

export function kernelStatusText(kernel?: KernelStatus) {
  if (!kernel) return "stopped"
  const runs = `${kernel.execution_count} ${kernel.execution_count === 1 ? "run" : "runs"}`
  const queued = kernel.queue_depth > 0 ? ` · ${kernel.queue_depth} queued` : ""
  const runtime = kernel.incarnation === null ? "" : ` · r${kernel.incarnation}`
  return `${kernel.state}${runtime} · ${runs}${queued}`
}

export function kernelCanInterrupt(kernel?: KernelStatus) {
  return kernel?.state === "running"
}

export function kernelCanStop(kernel?: KernelStatus) {
  return kernel?.state === "starting" || kernel?.active === true
}

export function kernelCanForget(kernel?: KernelStatus) {
  if (!kernel || kernel.name === "agent") return false
  return !kernel.active && kernel.state !== "starting"
}

export function kernelLanguageLabel(kernel?: KernelStatus) {
  if (!kernel) return "Unknown"
  if (kernel.language === "python") return "Python"
  if (kernel.language === "r") return "R"
  return kernel.language
}

export function kernelOwnershipLabel(kernel: KernelStatus, routeID?: string) {
  if (routeID && routeID !== "new" && routeID === kernel.sessionID) return "This session"
  return "Project session"
}

export function kernelRecoveryLabel(kernel: KernelStatus) {
  if (kernel.state === "lazy") return "No process is running. The first cell starts a fresh runtime."
  if (kernel.state === "starting") return "Starting the interpreter and applying its environment."
  if (kernel.state === "running" && kernel.queue_depth === 1) {
    return "Executing now. 1 cell is waiting in this kernel."
  }
  if (kernel.state === "running" && kernel.queue_depth > 1) {
    return `Executing now. ${kernel.queue_depth} cells are waiting in this kernel.`
  }
  if (kernel.state === "running") return "Executing now."
  if (kernel.state === "crashed") return "The process exited. Restart to replace it; in-memory variables were lost."
  if (kernel.state === "stopped") return "Run a cell to start a fresh runtime."
  if (kernel.execution_count === 0) return "Ready for the first cell."
  return "Ready. In-memory state persists for the next cell."
}

export function kernelTargetLabel(kernel?: KernelStatus) {
  if (!kernel) return "Unavailable"
  if (kernel.target.kind === "local") return "Local"
  return "Unavailable"
}

export function kernelCpuLabel(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "Unavailable"
  return `${value.toFixed(1)}%`
}

export function kernelMemoryLabel(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "Unavailable"
  if (value < 1_000) return `${Math.round(value)} B`
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`
  if (value < 1_000_000_000) return `${Math.round(value / 1_000_000)} MB`
  return `${(value / 1_000_000_000).toFixed(1)} GB`
}

export function kernelGpuLabel(value?: number) {
  return kernelCpuLabel(value)
}

export function kernelVramLabel(value?: number) {
  return kernelMemoryLabel(value)
}

export function kernelUptimeLabel(kernel?: KernelStatus, now = Date.now()) {
  if (!kernel?.active || !kernel.started_at) return "Unavailable"
  const seconds = Math.max(0, Math.floor((now - kernel.started_at) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function kernelAtlasLabel(kernel?: KernelStatus) {
  const atlas = kernel?.environment?.atlas
  if (!atlas) return "Atlas access pending"
  return "Atlas host broker · credentials withheld · source IDs only"
}

export function kernelEnvironmentLabel(kernel?: KernelStatus) {
  if (kernel?.authority?.mode === "read_only") return "Read-only · execution blocked"
  const sandbox = kernel?.environment?.sandbox
  if (!sandbox) return "Environment pending"
  // The network clause moved to its own line. Joined by a middot it made a
  // label long enough to wrap inside its pill, and it buried the one fact on
  // this card that changes what a run can reach.
  if (sandbox.enforced) return `${sandbox.backend.charAt(0).toUpperCase()}${sandbox.backend.slice(1)} sandbox`
  if (sandbox.requested) return "Sandbox unavailable · host access"
  return "Sandbox off · host access"
}

/**
 * Whether this runtime can reach the network, as its own statement.
 *
 * Null when nothing has been measured — an environment that has not reported a
 * sandbox is not a runtime with an open network, and saying so would be a
 * claim this card cannot make.
 */
export function kernelNetworkLabel(kernel?: KernelStatus) {
  const sandbox = kernel?.environment?.sandbox
  if (!sandbox) return null
  return sandbox.enforced && sandbox.network === "deny" ? "Network disabled" : "Network allowed"
}

/**
 * Reaching the network is the state worth noticing, so it carries the warning
 * tone and a blocked network stays grey. This is deliberately the opposite of
 * kernelEnvironmentTone, which reads an enforced sandbox as the good outcome:
 * there the question is whether the sandbox holds, here it is what the run can
 * still touch through it.
 */
export function kernelNetworkTone(kernel?: KernelStatus): KernelTone {
  const sandbox = kernel?.environment?.sandbox
  return sandbox?.enforced && sandbox.network === "deny" ? "muted" : "pending"
}

export function kernelEnvironmentTone(kernel?: KernelStatus): KernelTone {
  const sandbox = kernel?.environment?.sandbox
  if (!sandbox) return "muted"
  if (sandbox.enforced) return "ready"
  if (sandbox.requested) return "danger"
  return "pending"
}
