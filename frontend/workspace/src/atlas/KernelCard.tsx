import { createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import {
  kernelCanStop,
  kernelLabel,
  kernelLanguageLabel,
  kernelMemoryLabel,
  kernelRecoveryLabel,
  kernelStateLabel,
  kernelTone,
  kernelUptimeLabel,
  type KernelStatus,
} from "@/notebook/runtime"

export type KernelAction = "stop"

const memory = (value?: number) => {
  const label = kernelMemoryLabel(value)
  return label === "Unavailable" ? "—" : label
}

const cores = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
  return (value / 100).toFixed(1)
}

export function KernelCard(props: {
  kernel: KernelStatus
  action: string
  onControl: (action: KernelAction) => void
}): JSX.Element {
  const busy = () => props.action === `${props.kernel.id}:stop`
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!props.kernel.active || !props.kernel.started_at) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const uptime = () => kernelUptimeLabel(props.kernel, now())

  return (
    <article class="kernel-card" data-kernel-id={props.kernel.id} data-state={props.kernel.state}>
      <div class="kernel-card__main">
        <span class="kernel-card__language" aria-hidden="true">
          {props.kernel.language === "python" ? "Py" : props.kernel.language === "r" ? "R" : "›_"}
        </span>
        <div class="kernel-card__copy">
          <strong title={kernelLabel(props.kernel)}>{kernelLabel(props.kernel)}</strong>
          <span>
            <i data-tone={kernelTone(props.kernel.state)} aria-hidden="true" />
            {kernelStateLabel(props.kernel.state)} · {kernelRecoveryLabel(props.kernel)}
          </span>
        </div>
      </div>

      <span class="kernel-card__uptime" aria-label={`Uptime ${uptime()}`}>
        {uptime() === "Unavailable" ? "—" : uptime()}
      </span>
      <Metric label="rss" value={memory(props.kernel.resources?.memory_bytes)} />
      <Metric label="cores" value={cores(props.kernel.resources?.cpu_percent)} />
      <button
        type="button"
        class="kernel-card__stop"
        aria-label={`Stop ${kernelLabel(props.kernel)}`}
        title={`Stop this ${kernelLanguageLabel(props.kernel)} kernel and clear its in-memory state.`}
        disabled={!!props.action || !kernelCanStop(props.kernel)}
        onClick={() => props.onControl("stop")}
      >
        {busy() ? "Stopping…" : "Stop"}
      </button>
    </article>
  )
}

const ago = (value: number | null) => {
  if (!value) return "—"
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function KernelResultCard(props: { kernel: KernelStatus }): JSX.Element {
  return (
    <article class="kernel-card kernel-history-card" data-kernel-id={props.kernel.id} data-state={props.kernel.state}>
      <div class="kernel-card__main">
        <span class="kernel-card__language" aria-hidden="true">
          {props.kernel.language === "python" ? "Py" : props.kernel.language === "r" ? "R" : "›_"}
        </span>
        <div class="kernel-card__copy">
          <strong title={kernelLabel(props.kernel)}>{kernelLabel(props.kernel)}</strong>
          <span>
            <i data-tone={props.kernel.state === "crashed" ? "danger" : "muted"} aria-hidden="true" />
            {kernelStateLabel(props.kernel.state)} · output preserved in chat and Files
          </span>
        </div>
      </div>
      <span class="kernel-card__uptime" aria-label={`Finished ${ago(props.kernel.last_activity_at)}`}>
        {ago(props.kernel.last_activity_at)}
      </span>
      <span class="kernel-history-card__result">
        <strong>{props.kernel.state === "crashed" ? "Needs review" : "Complete"}</strong>
        <small>workspace cleared</small>
      </span>
    </article>
  )
}

function Metric(props: { label: string; value: string }): JSX.Element {
  return (
    <span class="kernel-card__metric">
      <strong>{props.value}</strong>
      <small>{props.label}</small>
    </span>
  )
}
