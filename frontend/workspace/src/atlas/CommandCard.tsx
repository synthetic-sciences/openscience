import { createSignal, onCleanup, type JSX } from "solid-js"
import { kernelMemoryLabel, type CommandStatus } from "@/atlas/kernel-runtime"

const memory = (value?: number) => {
  const label = kernelMemoryLabel(value)
  return label === "Unavailable" ? "Not captured" : label
}

const cores = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "Not captured"
  return `${(value / 100).toFixed(1)} cores`
}

const uptime = (started: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - started) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function CommandCard(props: { command: CommandStatus; stopping: boolean; onStop: () => void }): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  return (
    <article class="activity-card command-card" data-command-id={props.command.id} data-state="running">
      <header class="activity-card__header">
        <div class="activity-card__identity">
          <span class="activity-card__kind">Shell</span>
          <div class="kernel-card__copy">
            <strong title={props.command.description}>{props.command.description}</strong>
            <span>Running · {uptime(props.command.started_at, now())}</span>
          </div>
        </div>
        <span class="activity-card__status" data-tone="active">
          Running
        </span>
      </header>

      <div class="activity-card__actions">
        <button
          type="button"
          class="kernel-card__stop activity-card__danger"
          aria-label={`Stop ${props.command.description}`}
          title="Stop this live shell command and its child processes."
          disabled={props.stopping}
          aria-busy={props.stopping}
          onClick={props.onStop}
        >
          {props.stopping ? "Stopping…" : "Stop"}
        </button>
      </div>

      <div class="activity-card__disclosures">
        <details class="activity-disclosure">
          <summary>Command</summary>
          <div class="activity-disclosure__body">
            <pre>
              <code>{props.command.command}</code>
            </pre>
          </div>
        </details>
        <details class="activity-disclosure" data-quiet="true">
          <summary>Process details</summary>
          <div class="activity-disclosure__body">
            <dl class="activity-card__facts">
              <Fact label="Runtime" value={uptime(props.command.started_at, now())} />
              <Fact label="Memory" value={memory(props.command.resources?.memory_bytes)} />
              <Fact label="CPU" value={cores(props.command.resources?.cpu_percent)} />
              <Fact label="Process" value={props.command.process_id.toString()} mono />
              <Fact label="Command ID" value={props.command.id} mono />
            </dl>
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
