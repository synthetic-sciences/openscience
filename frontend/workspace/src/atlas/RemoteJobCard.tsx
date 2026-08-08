import { Show, createSignal, onCleanup, type JSX } from "solid-js"
import type { Job, Status } from "@/atlas/ComputeJobsAPI"

const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])

export function jobLive(job: Job) {
  if (!terminal.has(job.status)) return true
  const resource = job.lifecycle?.resource
  return job.target.kind === "modal" && (resource === "starting" || resource === "active" || resource === "unknown")
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
  return [gpu ? `${gpu}${count}` : undefined, cpu, memory].filter(Boolean).join(" · ") || "provider defaults"
}

const result = (job: Job) => {
  const files = (job.artifacts?.length ?? 0) + (job.checkpoint ? 1 : 0)
  const exit = job.exit_code === undefined || job.exit_code === null ? undefined : `exit ${job.exit_code}`
  const closed =
    job.target.kind === "modal"
      ? job.lifecycle?.resource === "closed"
        ? "remote released"
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
            <i data-tone={jobLive(props.job) ? "active" : props.job.status === "succeeded" ? "ready" : "danger"} />
            {props.job.target_label} · {resource(props.job)}
          </span>
        </div>
      </div>

      <span class="kernel-card__uptime" aria-label={`Runtime ${elapsed(props.job, now())}`}>
        {elapsed(props.job, now())}
      </span>
      <span class="remote-job-card__result">
        <strong>{props.job.status}</strong>
        <small>{result(props.job)}</small>
      </span>
      <div class="remote-job-card__actions">
        <button type="button" onClick={read} aria-expanded={output() !== undefined}>
          {loading() ? "Loading…" : output() === undefined ? "Output" : "Hide"}
        </button>
        <Show when={jobLive(props.job)}>
          <button type="button" disabled={props.cancelling} onClick={() => void props.onCancel()}>
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
