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
} from "@/atlas/kernel-runtime"

export type KernelAction = "restart" | "stop"

const memory = (value?: number) => {
  const label = kernelMemoryLabel(value)
  return label === "Unavailable" ? "Not captured" : label
}

const cores = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "Not captured"
  return `${(value / 100).toFixed(1)} cores`
}

export const kernelActivity = (kernel: KernelStatus) => {
  const executions = `${kernel.execution_count} ${kernel.execution_count === 1 ? "run" : "runs"}`
  const queued = kernel.queue_depth > 0 ? ` · ${kernel.queue_depth} queued` : ""
  const state = kernelStateLabel(kernel.state)
  return state === "Ready" ? `Warm for follow-up · ${executions}${queued}` : `${state} · ${executions}${queued}`
}

export function KernelCard(props: {
  kernel: KernelStatus
  action: string
  onControl: (action: KernelAction) => void
}): JSX.Element {
  const busy = (action: KernelAction) => props.action === `${props.kernel.id}:${action}`
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!props.kernel.active || !props.kernel.started_at) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const uptime = () => kernelUptimeLabel(props.kernel, now())
  const canControl = () => kernelCanStop(props.kernel)

  return (
    <article class="activity-card kernel-card" data-kernel-id={props.kernel.id} data-state={props.kernel.state}>
      <header class="activity-card__header">
        <div class="activity-card__identity">
          <span class="activity-card__kind">{kernelLanguageLabel(props.kernel)}</span>
          <div class="kernel-card__copy">
            <strong title={kernelLabel(props.kernel)}>{kernelLabel(props.kernel)}</strong>
            <span title={kernelRecoveryLabel(props.kernel)} data-slot="kernel-card-executions">
              {kernelActivity(props.kernel)}
            </span>
          </div>
        </div>
        <span class="activity-card__status" data-tone={kernelTone(props.kernel.state)}>
          {kernelStateLabel(props.kernel.state)}
        </span>
      </header>

      <div class="activity-card__actions" aria-label={`${kernelLabel(props.kernel)} controls`}>
        <button
          type="button"
          aria-label={`Restart ${kernelLabel(props.kernel)}`}
          title={`Restart this ${kernelLanguageLabel(props.kernel)} runtime and clear its in-memory state.`}
          disabled={!!props.action || !canControl()}
          aria-busy={busy("restart")}
          onClick={() => props.onControl("restart")}
        >
          {busy("restart") ? "Restarting…" : "Restart"}
        </button>
        <button
          type="button"
          class="kernel-card__stop activity-card__danger"
          aria-label={`Stop ${kernelLabel(props.kernel)}`}
          title={`Stop this ${kernelLanguageLabel(props.kernel)} runtime and clear its in-memory state.`}
          disabled={!!props.action || !canControl()}
          aria-busy={busy("stop")}
          onClick={() => props.onControl("stop")}
        >
          {busy("stop") ? "Stopping…" : "Stop"}
        </button>
      </div>

      <div class="activity-card__disclosures">
        <Show when={props.kernel.last_execution ?? props.kernel.last_cell}>
          {(execution) => (
            <details class="activity-disclosure kernel-card__cell">
              <summary>
                Code · {execution().execution_count ? `Run ${execution().execution_count}` : "Current execution"}
              </summary>
              <div class="activity-disclosure__body">
                <Show when={execution().title || execution().source}>
                  <p class="activity-disclosure__caption">
                    {execution().title || `${kernelLanguageLabel(props.kernel)} execution`}
                    <Show when={execution().source}>{(source) => ` · ${source()}`}</Show>
                  </p>
                </Show>
                <pre>
                  <code>{execution().code}</code>
                </pre>
              </div>
            </details>
          )}
        </Show>
        <details class="activity-disclosure" data-quiet="true">
          <summary>Runtime details</summary>
          <div class="activity-disclosure__body">
            <dl class="activity-card__facts">
              <Fact label="Runtime" value={uptime() === "Unavailable" ? "Not running" : uptime()} />
              <Fact label="Memory" value={memory(props.kernel.resources?.memory_bytes)} />
              <Fact label="CPU" value={cores(props.kernel.resources?.cpu_percent)} />
              <Fact label="Process" value={props.kernel.process_id?.toString() ?? "Not running"} mono />
              <Fact
                label="Environment"
                value={props.kernel.environment_name || props.kernel.environment?.interpreter?.name || "Default"}
              />
              <Fact label="Runtime ID" value={props.kernel.id} mono />
            </dl>
            <p class="activity-disclosure__note">{kernelRecoveryLabel(props.kernel)}</p>
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
