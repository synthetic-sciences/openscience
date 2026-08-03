import { For, Show, type JSX } from "solid-js"
import {
  kernelAtlasLabel,
  kernelCanForget,
  kernelCanInterrupt,
  kernelCanStop,
  kernelCpuLabel,
  kernelEnvironmentLabel,
  kernelEnvironmentTone,
  kernelGpuLabel,
  kernelLabel,
  kernelLanguageLabel,
  kernelMemoryLabel,
  kernelOwnershipLabel,
  kernelRecoveryLabel,
  kernelStateLabel,
  kernelTargetLabel,
  kernelTone,
  kernelUptimeLabel,
  kernelVramLabel,
  type KernelStatus,
} from "@/notebook/runtime"

export type KernelAction = "interrupt" | "restart" | "stop" | "delete"

const time = (value: number | null) => {
  if (!value) return "Unavailable"
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

const date = (value: number | null) => {
  if (!value) return "Unavailable"
  return new Date(value).toLocaleString()
}

export function KernelCard(props: {
  kernel: KernelStatus
  routeID?: string
  action: string
  restartDisabled?: boolean
  restartTitle?: string
  onControl: (action: KernelAction) => void
}): JSX.Element {
  const owner = () => kernelOwnershipLabel(props.kernel, props.routeID)
  const busy = (action: KernelAction) => props.action === `${props.kernel.id}:${action}`
  const launch = () => (props.kernel.active ? "Restart" : "Start runtime")
  const metrics = () =>
    [
      { label: "Target", value: kernelTargetLabel(props.kernel) },
      { label: "Runs", value: String(props.kernel.execution_count) },
      { label: "Queued", value: props.kernel.queue_depth > 0 ? String(props.kernel.queue_depth) : "Unavailable" },
      {
        label: "Runtime",
        value:
          props.kernel.active && props.kernel.incarnation !== null ? `r${props.kernel.incarnation}` : "Unavailable",
      },
      { label: "Uptime", value: kernelUptimeLabel(props.kernel) },
      { label: "CPU", value: kernelCpuLabel(props.kernel.resources?.cpu_percent) },
      { label: "Memory", value: kernelMemoryLabel(props.kernel.resources?.memory_bytes) },
      { label: "GPU", value: kernelGpuLabel(props.kernel.resources?.gpu_percent) },
      { label: "VRAM", value: kernelVramLabel(props.kernel.resources?.vram_bytes) },
    ].filter((metric) => metric.value !== "Unavailable")
  return (
    <article
      class="kernel-card"
      data-kernel-id={props.kernel.id}
      data-kernel-owner={owner()}
      data-owner-current={owner() === "This session"}
    >
      <div class="kernel-card__header">
        <span class="kernel-card__language" aria-hidden="true">
          {props.kernel.language === "python"
            ? "Py"
            : props.kernel.language === "r"
              ? "R"
              : props.kernel.language.slice(0, 2)}
        </span>
        <div class="kernel-card__title">
          <strong title={kernelLabel(props.kernel)}>{kernelLabel(props.kernel)}</strong>
          <span>
            {kernelLanguageLabel(props.kernel)} · {kernelTargetLabel(props.kernel)}
          </span>
        </div>
        <div class="kernel-card__meta">
          <span class="kernel-card__owner">{owner()}</span>
          <span class="kernel-card__state" data-tone={kernelTone(props.kernel.state)}>
            <span class="kernel-card__state-dot" aria-hidden="true" />
            <strong>{kernelStateLabel(props.kernel.state)}</strong>
          </span>
        </div>
      </div>

      <div
        class="kernel-card__metrics"
        role="group"
        aria-label="Kernel summary and available live usage"
        title="Live usage appears only when the host reports it."
      >
        <For each={metrics()}>{(metric) => <Metric label={metric.label} value={metric.value} />}</For>
      </div>

      <p class="kernel-card__recovery">{kernelRecoveryLabel(props.kernel)}</p>

      <div class="kernel-card__controls">
        <Show when={kernelCanInterrupt(props.kernel)}>
          <button
            type="button"
            aria-label={`Interrupt ${kernelLabel(props.kernel)}`}
            title="Interrupt the executing cell. The runtime will preserve state when supported."
            disabled={!!props.action}
            onClick={() => props.onControl("interrupt")}
          >
            {busy("interrupt") ? "Interrupting…" : "Interrupt"}
          </button>
        </Show>
        <button
          type="button"
          class="kernel-card__primary"
          aria-label={`${launch()} ${kernelLabel(props.kernel)}`}
          title={
            props.restartDisabled
              ? props.restartTitle
              : props.kernel.active
                ? "Replace this runtime now. All in-memory variables and queued cells will be lost."
                : "Start this kernel in a fresh runtime."
          }
          disabled={!!props.action || props.restartDisabled}
          onClick={() => props.onControl("restart")}
        >
          {busy("restart") ? (props.kernel.active ? "Restarting…" : "Starting…") : launch()}
        </button>
        <Show when={kernelCanStop(props.kernel)}>
          <button
            type="button"
            class="kernel-card__stop"
            aria-label={`Stop ${kernelLabel(props.kernel)}`}
            title="Stop the runtime and clear its in-memory state."
            disabled={!!props.action}
            onClick={() => props.onControl("stop")}
          >
            {busy("stop") ? "Stopping…" : "Stop"}
          </button>
        </Show>
        <Show when={kernelCanForget(props.kernel)}>
          <button
            type="button"
            aria-label={`Forget ${kernelLabel(props.kernel)}`}
            title="Delete this inactive runtime record. Notebook files and recorded outputs are unchanged."
            disabled={!!props.action}
            onClick={() => props.onControl("delete")}
          >
            {busy("delete") ? "Forgetting…" : "Forget record"}
          </button>
        </Show>
      </div>

      <details class="kernel-card__identity">
        <summary>Runtime details</summary>
        <div>
          <Show when={props.kernel.environment}>
            <section class="kernel-card__environment" aria-label={`${kernelLanguageLabel(props.kernel)} environment`}>
              <div class="kernel-card__environment-header">
                <strong>{kernelLanguageLabel(props.kernel)} environment</strong>
                <span data-tone={kernelEnvironmentTone(props.kernel)}>{kernelEnvironmentLabel(props.kernel)}</span>
              </div>
              <Show when={props.kernel.environment?.cwd}>
                {(cwd) => (
                  <div class="kernel-card__environment-row">
                    <span>Working directory</span>
                    <code title={cwd()}>{cwd()}</code>
                  </div>
                )}
              </Show>
              <Show when={props.kernel.environment?.atlas}>
                <div class="kernel-card__environment-row">
                  <span>Atlas boundary</span>
                  <p>{kernelAtlasLabel(props.kernel)}</p>
                </div>
              </Show>
            </section>
          </Show>
          <Identity label="Runtime ID" value={props.kernel.id} />
          <Identity label="Session ID" value={props.kernel.sessionID} />
          <Identity label="Project ID" value={props.kernel.projectID} />
          <Show when={props.kernel.process_id !== null}>
            <Identity label="Process ID" value={String(props.kernel.process_id)} />
          </Show>
          <Show when={props.kernel.process_identity_verified}>
            <Identity label="Process identity" value="PID and process start verified" />
          </Show>
          <Show when={props.kernel.process_started_at}>
            <Identity label="Process started" value={date(props.kernel.process_started_at)} />
          </Show>
          <Show when={props.kernel.started_at}>
            <Identity label="Started" value={date(props.kernel.started_at)} />
          </Show>
          <Show when={props.kernel.last_activity_at}>
            <Identity label="Last activity" value={time(props.kernel.last_activity_at)} />
          </Show>
        </div>
      </details>
    </article>
  )
}

function Metric(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="kernel-card__metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function Identity(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="kernel-card__identity-row">
      <span>{props.label}</span>
      <code title={props.value}>{props.value}</code>
    </div>
  )
}
