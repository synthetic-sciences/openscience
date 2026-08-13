import { For, Show, createSignal, onCleanup, type JSX } from "solid-js"
import type { Job, Status } from "@/atlas/ComputeJobsAPI"
import { kernelMemoryLabel } from "@/atlas/kernel-runtime"

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
  const attention: Job[] = []
  const completed: Job[] = []
  for (const job of jobs) {
    if (jobLive(job)) active.push(job)
    else if (job.status === "succeeded") completed.push(job)
    else attention.push(job)
  }
  attention.sort((a, b) => jobTime(b) - jobTime(a))
  completed.sort((a, b) => jobTime(b) - jobTime(a))
  return [...active, ...attention, ...completed.slice(0, completedLimit)]
}

const elapsed = (job: Job, now: number) => {
  const start = Date.parse(job.started_at ?? job.created_at)
  const end = job.completed_at ? Date.parse(job.completed_at) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Duration not captured"
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
  const memory = job.resources?.memory_gb ? `${job.resources.memory_gb} GB memory` : undefined
  return [gpu ? `${gpu}${count}` : undefined, cpu, memory].filter(Boolean).join(" · ") || "Provider defaults"
}

export const jobStatusLabel = (status: Status) => status.charAt(0).toUpperCase() + status.slice(1)

const fileCount = (job: Job) => (job.artifacts?.length ?? 0) + (job.checkpoint ? 1 : 0)

const result = (job: Job) => {
  if (job.error) return job.error.split("\n")[0]
  const files = fileCount(job)
  const exit = job.exit_code === undefined || job.exit_code === null ? undefined : `Exit ${job.exit_code}`
  if (job.status === "succeeded") {
    return [exit, files ? `${files} ${files === 1 ? "file" : "files"}` : "Completed"].filter(Boolean).join(" · ")
  }
  if (jobLive(job))
    return job.status === "queued" ? `Waiting for ${job.target_label}` : `Running on ${job.target_label}`
  return jobStatusLabel(job.status)
}

const tone = (job: Job) =>
  jobLive(job) ? "active" : job.status === "succeeded" ? "ready" : job.status === "cancelled" ? "muted" : "danger"

export function RemoteJobCard(props: {
  job: Job
  action: string
  onCancel: () => Promise<void>
  onRetry: () => Promise<void>
  onRelease: () => Promise<void>
  onOutput: () => Promise<string>
}): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const [output, setOutput] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  const action = (name: "cancel" | "retry" | "release") => props.action === `${props.job.id}:${name}`
  const recoverable = () => terminal.has(props.job.status) && props.job.lifecycle?.recoverable === true
  const releaseable = () =>
    props.job.target.kind === "modal" && terminal.has(props.job.status) && props.job.lifecycle?.resource === "unknown"

  const read = () => {
    if (output() !== undefined || loading()) return
    setLoading(true)
    void props
      .onOutput()
      .then((value) => setOutput(value || "No logs were captured for this job."))
      .catch((error: unknown) => setOutput(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }

  return (
    <article class="activity-card remote-job-card" data-job-id={props.job.id} data-state={props.job.status}>
      <header class="activity-card__header">
        <div class="activity-card__identity">
          <span class="activity-card__kind">
            {props.job.modal?.gpu && props.job.modal.gpu !== "none" ? "Remote GPU" : "Remote job"}
          </span>
          <div class="kernel-card__copy">
            <strong title={props.job.name}>{props.job.name}</strong>
            <span>{result(props.job)}</span>
          </div>
        </div>
        <Show when={props.job.status !== "succeeded"}>
          <span class="activity-card__status" data-tone={tone(props.job)}>
            {jobStatusLabel(props.job.status)}
          </span>
        </Show>
      </header>

      <p class="activity-card__summary">
        {props.job.target_label} · {elapsed(props.job, now())}
        <Show when={fileCount(props.job) > 0}>
          {` · ${fileCount(props.job)} ${fileCount(props.job) === 1 ? "file" : "files"}`}
        </Show>
      </p>

      <Show when={props.job.error || props.job.capture_error || props.job.cleanup_error}>
        <p class="remote-job-card__warning" role="alert">
          {props.job.error || props.job.capture_error || props.job.cleanup_error}
        </p>
      </Show>

      <Show when={props.job.target.kind === "modal" && jobLive(props.job)}>
        <p class="remote-job-card__billing" role="status">
          Modal billing may continue until this job exits, is cancelled, or reaches its{" "}
          {props.job.modal?.timeout_minutes}
          -minute timeout.
        </p>
      </Show>

      <div class="activity-card__actions">
        <Show when={jobLive(props.job)}>
          <button
            type="button"
            class="activity-card__danger"
            disabled={!!props.action}
            aria-busy={action("cancel")}
            onClick={() => void props.onCancel()}
          >
            {action("cancel") ? "Cancelling…" : "Cancel"}
          </button>
        </Show>
        <Show when={recoverable()}>
          <button
            type="button"
            disabled={!!props.action}
            aria-busy={action("retry")}
            onClick={() => void props.onRetry()}
          >
            {action("retry") ? "Retrying…" : "Retry output"}
          </button>
        </Show>
        <Show when={releaseable()}>
          <button
            type="button"
            disabled={!!props.action}
            aria-busy={action("release")}
            onClick={() => void props.onRelease()}
          >
            {action("release") ? "Releasing…" : "Retry cleanup"}
          </button>
        </Show>
      </div>

      <div class="activity-card__disclosures">
        <details class="activity-disclosure" onToggle={(event) => event.currentTarget.open && read()}>
          <summary>Logs</summary>
          <div class="activity-disclosure__body">
            <pre>{loading() ? "Loading logs…" : (output() ?? "Open to load logs.")}</pre>
          </div>
        </details>
        <Show when={fileCount(props.job) > 0}>
          <details class="activity-disclosure">
            <summary>Files</summary>
            <div class="activity-disclosure__body">
              <ul class="execution-card__files">
                <For each={props.job.artifacts ?? []}>
                  {(file) => (
                    <li>
                      <span>{file.path}</span>
                      <small>{kernelMemoryLabel(file.size)}</small>
                    </li>
                  )}
                </For>
                <Show when={props.job.checkpoint}>
                  {(file) => (
                    <li>
                      <span>{file().path}</span>
                      <small>Checkpoint · {kernelMemoryLabel(file().size)}</small>
                    </li>
                  )}
                </Show>
              </ul>
            </div>
          </details>
        </Show>
        <details class="activity-disclosure" data-quiet="true">
          <summary>Job details</summary>
          <div class="activity-disclosure__body">
            <dl class="activity-card__facts">
              <Fact label="Target" value={props.job.target_label} />
              <Fact label="Resources" value={resource(props.job)} />
              <Fact label="Scheduler" value={props.job.scheduler} />
              <Show when={props.job.modal?.timeout_minutes}>
                {(minutes) => <Fact label="Timeout" value={`${minutes()} minutes`} />}
              </Show>
              <Fact label="Resource state" value={props.job.lifecycle?.resource ?? "Not reported"} />
              <Fact label="Delivery" value={props.job.lifecycle?.delivery ?? "Not reported"} />
              <Fact label="Remote ID" value={props.job.remote_id ?? "Not reported"} mono />
              <Fact label="Job ID" value={props.job.id} mono />
            </dl>
            <pre>
              <code>{props.job.command}</code>
            </pre>
          </div>
        </details>
      </div>
    </article>
  )
}

function Fact(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd data-mono={props.mono ? "true" : undefined}>{props.value}</dd>
    </div>
  )
}
