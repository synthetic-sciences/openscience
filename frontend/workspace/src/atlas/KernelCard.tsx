import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
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
            {kernelStateLabel(props.kernel.state)} ·
            <span data-slot="kernel-card-executions">
              {props.kernel.execution_count} {props.kernel.execution_count === 1 ? "cell" : "cells"}
            </span>
            · {kernelRecoveryLabel(props.kernel)}
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
      <Show when={props.kernel.last_cell}>
        {(cell) => (
          <details class="kernel-card__cell">
            <summary>
              <span>
                {cell().execution_count ? `Cell ${cell().execution_count}` : "Current cell"} · {cell().status}
              </span>
              <strong>{cell().title || `${kernelLanguageLabel(props.kernel)} cell`}</strong>
              <Show when={cell().source}>{(source) => <small>{source()}</small>}</Show>
            </summary>
            <pre>
              <code>{cell().code}</code>
            </pre>
          </details>
        )}
      </Show>
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
