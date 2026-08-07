import { Index, Show, createSignal, type JSX } from "solid-js"
import { IconChevronDown, IconChevronRight } from "@/atlas/shared/Icon"
import type { Capacity } from "./host-instruments"
import { plateEyebrow, plateUsage } from "./kernel-plate"
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
  index?: number
  capacity?: Partial<Capacity>
  restartDisabled?: boolean
  restartTitle?: string
  onControl: (action: KernelAction) => void
}): JSX.Element {
  const owner = () => kernelOwnershipLabel(props.kernel, props.routeID)
  const busy = (action: KernelAction) => props.action === `${props.kernel.id}:${action}`
  // Collapsed by default. A session can hold several runtimes, and the full
  // plate is nine rows of ledger plus three controls — stacked, that buries
  // the one question the list is for, which is which kernels exist and whether
  // any of them is busy. The head answers that without opening anything.
  const [open, setOpen] = createSignal(false)
  const usage = () => plateUsage(props.kernel, props.capacity)
  return (
    <article
      class="kernel-card"
      data-kernel-id={props.kernel.id}
      data-kernel-owner={owner()}
      data-owner-current={owner() === "This session"}
      data-open={open()}
    >
      {/* The whole head is the toggle, not a caret-sized target: on a tablet
          the caret alone is well under the 44px a thumb can reliably hit. */}
      <button
        type="button"
        class="kernel-card__plate"
        aria-expanded={open()}
        aria-label={`${open() ? "Collapse" : "Expand"} ${kernelLabel(props.kernel)}`}
        onClick={() => setOpen(!open())}
      >
        <div class="kernel-card__header">
          <span class="kernel-card__language" aria-hidden="true">
            {plateEyebrow(props.kernel, props.index ?? 0)}
          </span>
          <div class="kernel-card__title">
            <strong title={kernelLabel(props.kernel)}>{kernelLabel(props.kernel)}</strong>
          </div>
          <span class="kernel-card__lede">
            {/* Uptime is only a fact while something is up. On a stopped
                record it read "Unavailable", which is three times the width of
                the figure it replaces and says nothing the pill beside it does
                not already say. */}
            <Show when={kernelUptimeLabel(props.kernel) !== "Unavailable"}>
              <span class="kernel-card__uptime">{kernelUptimeLabel(props.kernel)}</span>
            </Show>
            <span class="kernel-card__state" data-tone={kernelTone(props.kernel.state)}>
              {kernelStateLabel(props.kernel.state)}
            </span>
            <span class="kernel-card__caret" aria-hidden="true">
              {open() ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
            </span>
          </span>
        </div>

        {/* Survives the collapse, because "is this runtime in my way" is the
            question a collapsed list still has to answer. */}
        <div class="kernel-card__usage">
          <div class="kernel-card__usage-item">
            <div class="kernel-card__usage-label">
              <span>RAM</span>
              <span>
                <strong>{usage().ram}</strong> {usage().ceiling}
              </span>
            </div>
            <div class="kernel-card__usage-track">
              <div class="kernel-card__usage-fill" style={{ width: `${Math.round(usage().fill * 100)}%` }} />
            </div>
          </div>
          <div class="kernel-card__usage-item">
            <div class="kernel-card__usage-label">
              <span>CORES</span>
              <span>
                <strong>{usage().cores}</strong> / {usage().segments}
              </span>
            </div>
            <div class="kernel-card__usage-cores">
              <Index each={Array.from({ length: usage().segments })}>
                {(_, index) => <div data-lit={index < usage().lit} />}
              </Index>
            </div>
          </div>
        </div>
      </button>

      <Show when={open()}>
        <Show when={owner() !== "This session"}>
          <span class="kernel-card__owner">{owner()}</span>
        </Show>

        <div class="kernel-card__metrics">
          <Metric label="Lifecycle" value={kernelStateLabel(props.kernel.state)} />
          <Metric label="Executions" value={String(props.kernel.execution_count)} />
          <Metric label="Queued" value={String(props.kernel.queue_depth)} />
          <Metric
            label="Runtime"
            value={props.kernel.incarnation === null ? "Unavailable" : `r${props.kernel.incarnation}`}
          />
        </div>

        <div
          class="kernel-card__metrics kernel-card__metrics--usage"
          role="group"
          aria-label="Target and live usage, sampled on each refresh"
          title="CPU and memory are sampled by the server on each refresh. Unavailable means the platform did not report a value."
        >
          <Metric label="Target" value={kernelTargetLabel(props.kernel)} />
          <Metric label="Uptime" value={kernelUptimeLabel(props.kernel)} />
          <Metric label="CPU" value={kernelCpuLabel(props.kernel.resources?.cpu_percent)} />
          <Metric label="Memory" value={kernelMemoryLabel(props.kernel.resources?.memory_bytes)} />
          <Metric label="GPU" value={kernelGpuLabel(props.kernel.resources?.gpu_percent)} />
          <Metric label="VRAM" value={kernelVramLabel(props.kernel.resources?.vram_bytes)} />
        </div>

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

        <p class="kernel-card__recovery">{kernelRecoveryLabel(props.kernel)}</p>

        <div class="kernel-card__controls">
          <button
            type="button"
            aria-label={`Interrupt ${kernelLabel(props.kernel)}`}
            title={
              kernelCanInterrupt(props.kernel)
                ? "Interrupt the executing cell. The runtime will preserve state when supported."
                : "Interrupt is available while this kernel is executing."
            }
            disabled={!!props.action || !kernelCanInterrupt(props.kernel)}
            onClick={() => props.onControl("interrupt")}
          >
            {busy("interrupt") ? "Interrupting…" : "Interrupt"}
          </button>
          <button
            type="button"
            aria-label={`Restart ${kernelLabel(props.kernel)}`}
            title={
              props.restartDisabled
                ? props.restartTitle
                : "Replace this runtime now. All in-memory variables and queued cells will be lost."
            }
            disabled={!!props.action || props.restartDisabled}
            onClick={() => props.onControl("restart")}
          >
            {busy("restart") ? "Restarting…" : "Restart"}
          </button>
          <button
            type="button"
            class="kernel-card__stop"
            aria-label={`Stop ${kernelLabel(props.kernel)}`}
            title={
              kernelCanStop(props.kernel)
                ? "Stop the runtime and clear its in-memory state."
                : "This runtime is already stopped."
            }
            disabled={!!props.action || !kernelCanStop(props.kernel)}
            onClick={() => props.onControl("stop")}
          >
            {busy("stop") ? "Stopping…" : "Stop"}
          </button>
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
          <summary>Runtime identity</summary>
          <div>
            <Identity label="Runtime ID" value={props.kernel.id} />
            <Identity label="Session ID" value={props.kernel.sessionID} />
            <Identity label="Project ID" value={props.kernel.projectID} />
            <Identity
              label="Process ID"
              value={props.kernel.process_id === null ? "Unavailable" : String(props.kernel.process_id)}
            />
            <Identity
              label="Process identity"
              value={props.kernel.process_identity_verified ? "PID and process start verified" : "Unavailable"}
            />
            <Identity label="Process started" value={date(props.kernel.process_started_at)} />
            <Identity label="Started" value={date(props.kernel.started_at)} />
            <Identity label="Last activity" value={time(props.kernel.last_activity_at)} />
          </div>
        </details>
      </Show>
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
