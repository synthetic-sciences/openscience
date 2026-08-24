import { Show, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon, type IconProps } from "@synsci/ui/icon"
import type { Job, Status } from "@/atlas/ComputeJobsAPI"

const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])
const attentionResource = new Set(["starting", "active", "unknown"])

export function jobLive(job: Job) {
  if (!terminal.has(job.status)) return true
  const lifecycle = job.lifecycle
  if (!lifecycle) return job.status === "interrupted"
  return lifecycle.delivery === "pending" || lifecycle.recoverable || attentionResource.has(lifecycle.resource)
}

export function modalBillingRisk(job: Job) {
  return job.target.kind === "modal" && attentionResource.has(job.lifecycle?.resource ?? "unknown")
}

const jobTime = (job: Job) => Date.parse(job.started_at ?? job.created_at) || 0

/** Compute is a live tracker, not a completed-history surface. A terminal job
 * remains visible while delivery, recovery, or cleanup is still pending. */
export function visibleJobs(jobs: Job[]) {
  return jobs.filter(jobLive).sort((a, b) => jobTime(b) - jobTime(a))
}

const elapsed = (job: Job, now: number) => {
  const start = Date.parse(job.started_at ?? job.created_at)
  if (!Number.isFinite(start)) return ""
  const seconds = Math.max(0, Math.floor((now - start) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const resources = (job: Job) => {
  const gpuName = job.modal?.gpu && job.modal.gpu !== "none" ? job.modal.gpu : undefined
  const gpuCount = job.resources?.gpus
  const gpu = gpuName
    ? `${gpuName}${gpuCount && gpuCount > 1 ? ` × ${gpuCount}` : ""}`
    : gpuCount
      ? `${gpuCount} ${gpuCount === 1 ? "GPU" : "GPUs"}`
      : undefined
  const cpu = job.resources?.cpus ? `${job.resources.cpus} CPU` : undefined
  const memory = job.resources?.memory_gb ? `${job.resources.memory_gb} GB` : undefined
  return [gpu, cpu, memory].filter(Boolean).join(" · ") || "Provider defaults"
}

export const jobStatusLabel = (status: Status) => status.charAt(0).toUpperCase() + status.slice(1)

const activity = (job: Job, now: number) => {
  const time = elapsed(job, now)
  if (terminal.has(job.status)) {
    const lifecycle = job.lifecycle
    const attention =
      lifecycle?.delivery === "pending"
        ? "collecting output"
        : lifecycle?.recoverable
          ? "output recovery pending"
          : lifecycle && attentionResource.has(lifecycle.resource)
            ? "remote cleanup pending"
            : !lifecycle && job.status === "interrupted"
              ? "remote state unknown"
              : undefined
    return [jobStatusLabel(job.status), attention].filter(Boolean).join(" · ")
  }
  return `${jobStatusLabel(job.status)}${time ? ` · ${time}` : ""} · ${job.target_label}`
}

const billing = (job: Job) => {
  const timeout = job.modal?.timeout_minutes
  return timeout
    ? `Billing can continue until exit or the ${timeout}-minute timeout.`
    : "Billing can continue until the remote resource exits or is released."
}

const kind = (job: Job) => {
  if (job.target.kind === "local") return { icon: "cpu" as IconProps["name"], label: "Local job" }
  if (job.target.kind === "modal") return { icon: "cloud" as IconProps["name"], label: "Remote GPU job" }
  return { icon: "server" as IconProps["name"], label: "Remote job" }
}

export function RemoteJobCard(props: { job: Job }): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))
  const identity = () => kind(props.job)
  const warning = () => props.job.cleanup_error || props.job.capture_error || props.job.error

  return (
    <article class="compute-row remote-job-card" data-job-id={props.job.id} data-state={props.job.status}>
      <span class="compute-row__kind compute-row__kind--job" aria-label={identity().label}>
        <Icon name={identity().icon} />
      </span>
      <div class="compute-row__copy">
        <strong title={props.job.name}>{props.job.name}</strong>
        <span>{activity(props.job, now())}</span>
        <Show when={warning()}>{(message) => <small role="alert">{message().split("\n")[0]}</small>}</Show>
        <Show when={modalBillingRisk(props.job)}>
          <small role="status">{billing(props.job)}</small>
        </Show>
      </div>
      <div class="compute-row__request" aria-label="Requested resources">
        <small>Requested</small>
        <span>{resources(props.job)}</span>
      </div>
    </article>
  )
}
