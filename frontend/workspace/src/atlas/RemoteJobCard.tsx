import { Show, createSignal, onCleanup, type JSX } from "solid-js"
import type { Job, Status } from "@/atlas/ComputeJobsAPI"

const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])
const RECENT_COMPLETED_LIMIT = 8

export function jobLive(job: Job) {
  if (!terminal.has(job.status)) return true
  const resource = job.lifecycle?.resource
  return job.target.kind === "modal" && (resource === "starting" || resource === "active" || resource === "unknown")
}

const jobTime = (job: Job) => Date.parse(job.completed_at ?? job.started_at ?? job.created_at) || 0

export function visibleJobs(jobs: Job[], completedLimit = RECENT_COMPLETED_LIMIT) {
  const active: Job[] = []
  const completed: Job[] = []
  for (const job of jobs) {
    if (jobLive(job)) active.push(job)
    else completed.push(job)
  }
  completed.sort((a, b) => jobTime(b) - jobTime(a))
  return [...active, ...completed.slice(0, completedLimit)]
}

const elapsed = (job: Job, now: number) => {
  const start = Date.parse(job.started_at ?? job.created_at)
  const end = job.completed_at ? Date.parse(job.completed_at) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—"
  const seconds = Math.max(0, Math.floor((end - start) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const resource = (job: Job) => {
  const gpu = job.modal?.gpu && job.modal.gpu !== "none" ? job.modal.gpu : undefined
  const count = job.resources?.gpus && job.resources.gpus > 1 ? ` × ${job.resources.gpus}` : ""
  const cpu = job.resources?.cpus ? `${job.resources.cpus} CPU` : undefined
  const memory = job.resources?.memory_gb ? `${job.resources.memory_gb} GB` : undefined
  return [gpu ? `${gpu}${count}` : undefined, cpu, memory].filter(Boolean).join(" · ") || "Provider defaults"
}

export const jobStatusLabel = (status: Status) => {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

const result = (job: Job) => {
  const files = (job.artifacts?.length ?? 0) + (job.checkpoint ? 1 : 0)
  const exit = job.exit_code === undefined || job.exit_code === null ? undefined : `Exit ${job.exit_code}`
  const closed =
    job.target.kind === "modal"
      ? job.lifecycle?.resource === "closed"
        ? "Remote released"
        : job.lifecycle?.resource
      : undefined
  return [exit, `${files} ${files === 1 ? "artifact" : "artifacts"}`, closed].filter(Boolean).join(" · ")
}

export function RemoteJobCard(props: {
  job: Job
  cancelling: boolean
  onCancel: () => Promise<void>
  onOutput: () => Promise<string>
}): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const [output, setOutput] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  const read = () => {
    if (output() !== undefined) {
      setOutput(undefined)
      return
    }
    setLoading(true)
    void props
      .onOutput()
      .then((value) => setOutput(value || "No output was captured for this job."))
      .catch((error: unknown) => setOutput(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }

  return (
    <article class="kernel-card remote-job-card" data-job-id={props.job.id} data-state={props.job.status}>
      <div class="kernel-card__main">
        <span class="kernel-card__language" aria-hidden="true">
          {props.job.modal?.gpu && props.job.modal.gpu !== "none" ? "GPU" : "Job"}
        </span>
        <div class="kernel-card__copy">
          <strong title={props.job.name}>{props.job.name}</strong>
          <span title={props.job.command}>
            <i
              data-tone={jobLive(props.job) ? "active" : props.job.status === "succeeded" ? "ready" : "danger"}
              aria-hidden="true"
            />
            {props.job.target_label} · {resource(props.job)}
          </span>
        </div>
      </div>

      <div class="remote-job-card__summary" aria-label="Remote job status and runtime">
        <span class="kernel-card__uptime kernel-card__metric" aria-label={`Runtime ${elapsed(props.job, now())}`}>
          <strong>{elapsed(props.job, now())}</strong>
          <small>Runtime</small>
        </span>
        <span class="remote-job-card__result">
          <strong>{jobStatusLabel(props.job.status)}</strong>
          <small>{result(props.job)}</small>
        </span>
      </div>
      <div class="remote-job-card__actions">
        <button type="button" onClick={read} aria-expanded={output() !== undefined} aria-busy={loading()}>
          {loading() ? "Loading…" : output() === undefined ? "Output" : "Hide"}
        </button>
        <Show when={jobLive(props.job)}>
          <button
            type="button"
            disabled={props.cancelling}
            aria-busy={props.cancelling}
            onClick={() => void props.onCancel()}
          >
            {props.cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </Show>
      </div>
      <Show when={props.job.error || props.job.capture_error || props.job.cleanup_error}>
        <p class="remote-job-card__warning" role="alert">
          {props.job.error || props.job.capture_error || props.job.cleanup_error}
        </p>
      </Show>
      <Show when={output() !== undefined}>
        <pre class="remote-job-card__output">{output()}</pre>
      </Show>
    </article>
  )
}
