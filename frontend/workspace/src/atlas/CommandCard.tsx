import { createSignal, onCleanup, type JSX } from "solid-js"
import { kernelMemoryLabel, type CommandStatus } from "@/notebook/runtime"

const memory = (value?: number) => {
  const label = kernelMemoryLabel(value)
  return label === "Unavailable" ? "—" : label
}

const cores = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
  return (value / 100).toFixed(1)
}

const uptime = (started: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - started) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function CommandCard(props: { command: CommandStatus; stopping: boolean; onStop: () => void }): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  return (
    <article class="kernel-card command-card" data-command-id={props.command.id} data-state="running">
      <div class="kernel-card__main">
        <span class="kernel-card__language" aria-hidden="true">
          sh
        </span>
        <div class="kernel-card__copy">
          <strong title={props.command.description}>{props.command.description}</strong>
          <span title={props.command.command}>
            <i data-tone="active" aria-hidden="true" />
            bash · {props.command.command}
          </span>
        </div>
      </div>

      <span class="kernel-card__uptime" aria-label={`Uptime ${uptime(props.command.started_at, now())}`}>
        {uptime(props.command.started_at, now())}
      </span>
      <Metric label="rss" value={memory(props.command.resources?.memory_bytes)} />
      <Metric label="cores" value={cores(props.command.resources?.cpu_percent)} />
      <button
        type="button"
        class="kernel-card__stop"
        aria-label={`Stop ${props.command.description}`}
        title="Stop this live shell command and its child processes."
        disabled={props.stopping}
        onClick={props.onStop}
      >
        {props.stopping ? "Stopping…" : "Stop"}
      </button>
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
