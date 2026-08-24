import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { FileIcon } from "@synsci/ui/file-icon"
import { ComputeMetric } from "@/atlas/ComputeMetric"
import { kernelLabel, kernelLanguageLabel, kernelMemoryLabel, type KernelStatus } from "@/atlas/kernel-runtime"

const age = (then: number | null, now: number) => {
  if (!then) return ""
  const seconds = Math.max(0, Math.floor((now - then) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const memory = (value?: number) => {
  const label = kernelMemoryLabel(value)
  return label === "Unavailable" ? "— RSS" : `${label} RSS`
}

const cores = (value?: number) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "— cores"
  return `${(value / 100).toFixed(1)} cores`
}

const runs = (kernel: KernelStatus) => `${kernel.execution_count} ${kernel.execution_count === 1 ? "run" : "runs"}`

export const kernelActivity = (kernel: KernelStatus, now = Date.now()) => {
  const queued = kernel.queue_depth > 0 ? ` · ${kernel.queue_depth} queued` : ""
  if (kernel.state === "running") {
    const completed = kernel.execution_count > 0 ? ` · ${runs(kernel)} completed` : ""
    return `Running${completed}${queued}`
  }
  if (kernel.state === "starting") return `Starting · ${runs(kernel)}${queued}`
  if (kernel.state === "idle") {
    const idle = age(kernel.last_activity_at, now)
    return `Idle${idle ? ` ${idle}` : ""} · ${runs(kernel)}${queued}`
  }
  return `${kernel.state.charAt(0).toUpperCase()}${kernel.state.slice(1)} · ${runs(kernel)}${queued}`
}

const marker = (kernel: KernelStatus) =>
  kernel.language === "python" ? "kernel.py" : kernel.language === "r" ? "kernel.r" : "kernel.txt"

const environment = (kernel: KernelStatus) => {
  const name = kernel.environment_name?.trim()
  if (!name || name === "default" || name === kernel.language) return
  return name
}

export function KernelCard(props: { kernel: KernelStatus; sample?: number }): JSX.Element {
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    if (!props.kernel.active) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const title = () =>
    props.kernel.last_execution?.title?.trim() ||
    props.kernel.last_execution?.source?.trim() ||
    kernelLabel(props.kernel)

  return (
    <article class="compute-row kernel-card" data-kernel-id={props.kernel.id} data-state={props.kernel.state}>
      <span class="compute-row__kind" aria-label={kernelLanguageLabel(props.kernel)}>
        <FileIcon node={{ path: marker(props.kernel), type: "file" }} />
      </span>
      <div class="compute-row__copy">
        <strong title={title()}>{title()}</strong>
        <span data-slot="kernel-card-executions">
          {kernelActivity(props.kernel, now())}
          <Show when={environment(props.kernel)}>{(name) => ` · ${name()}`}</Show>
        </span>
      </div>
      <div class="compute-row__metrics" aria-label="Current kernel resources">
        <ComputeMetric
          metric="memory"
          label={memory(props.kernel.resources?.memory_bytes)}
          value={props.kernel.resources?.memory_bytes}
          sample={props.sample}
        />
        <ComputeMetric
          metric="cpu"
          label={cores(props.kernel.resources?.cpu_percent)}
          value={props.kernel.resources?.cpu_percent}
          sample={props.sample}
        />
      </div>
    </article>
  )
}
