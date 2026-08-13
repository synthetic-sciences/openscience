import { For, type JSX } from "solid-js"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"

// Mirrors backend/cli/src/compute/jobs.ts truthfully: the final scheduler
// wrapper (sbatch/qsub argv, job name, log path) is composed server-side at
// dispatch with the new job id, so this preview shows the exact user-authored
// command plus honest notes about how it will be wrapped — never a fabricated
// wrapper command line.

export type Remote = {
  kind: "ssh" | "modal"
  label: string
  host: string
  scheduler: "none" | "slurm" | "pbs"
}

export type Staged = {
  purpose: string
  command: string
  cwd?: string
  remote?: Remote
  resources?: {
    cpus?: number
    gpus?: number
    memory_gb?: number
    time_minutes?: number
    partition?: string
  }
  modules?: string[]
  container?: string
}

export function dispatchReady(input: {
  name: string
  purpose: string
  command: string
  reviewed: boolean
  busy: boolean
}) {
  if (input.busy || !input.reviewed) return false
  return !!input.name.trim() && !!input.purpose.trim() && !!input.command.trim()
}

export function previewNotes(staged: Staged): string[] {
  const remote = staged.remote
  if (!remote) {
    const skipped =
      staged.modules?.length || staged.container
        ? ["Environment modules and the runtime image are recorded with the job but applied only on remote hosts."]
        : []
    return [
      "Runs on this computer in your login shell. The exit code and output are captured with the job.",
      ...skipped,
    ]
  }
  if (remote.kind === "modal") {
    return [
      "Runs asynchronously outside the local sandbox in your Modal account. Your account may be billed until the run exits, is cancelled, or reaches its timeout.",
      "Only reviewed inputs are uploaded and only declared outputs are harvested back into this project.",
    ]
  }
  const load = staged.modules?.length
    ? [`module load ${staged.modules.join(" ")} runs before the command on ${remote.host}.`]
    : []
  const wrap = staged.container ? [`The command runs inside apptainer exec ${staged.container} on ${remote.host}.`] : []
  if (remote.scheduler === "slurm") {
    return [
      `Sent over SSH to ${remote.label} (${remote.host}) and wrapped for sbatch on dispatch. The exact sbatch command is composed at submission with the new job id and log path.`,
      ...(staged.resources
        ? ["Staged CPU, GPU, memory, time, and partition values become sbatch resource flags."]
        : []),
      ...load,
      ...wrap,
    ]
  }
  if (remote.scheduler === "pbs") {
    return [
      `Sent over SSH to ${remote.label} (${remote.host}) and submitted as a qsub batch script on dispatch. The exact script is composed at submission with the new job id and log path.`,
      ...(staged.resources ? ["Staged CPU, GPU, memory, and time values become qsub resource limits."] : []),
      ...(staged.resources?.partition
        ? ["The queue or partition value is not applied to qsub submissions today."]
        : []),
      ...load,
      ...wrap,
    ]
  }
  return [`Sent over SSH to ${remote.label} (${remote.host}) and run with bash -lc.`, ...load, ...wrap]
}

function scheduler(remote?: Remote) {
  if (!remote) return "None · direct shell"
  if (remote.kind === "modal") return "Modal · managed sandbox"
  if (remote.scheduler === "slurm") return "Slurm · sbatch"
  if (remote.scheduler === "pbs") return "PBS · qsub"
  return "None · bash -lc over SSH"
}

function resourceText(resources: NonNullable<Staged["resources"]>) {
  return [
    resources.cpus ? `${resources.cpus} CPU` : undefined,
    resources.gpus !== undefined ? `${resources.gpus} GPU` : undefined,
    resources.memory_gb ? `${resources.memory_gb} GB` : undefined,
    resources.time_minutes ? `${resources.time_minutes} min` : undefined,
    resources.partition,
  ]
    .filter((value): value is string => !!value)
    .join(" · ")
}

export function DispatchPreview(props: { staged: Staged }): JSX.Element {
  const rows = () => {
    const staged = props.staged
    return [
      {
        label: "Target",
        value: staged.remote ? `${staged.remote.label} · ${staged.remote.host}` : "This computer",
      },
      { label: "Purpose", value: staged.purpose },
      { label: "Scheduler", value: scheduler(staged.remote) },
      { label: "Working directory", value: staged.cwd || "Project directory" },
      ...(staged.resources ? [{ label: "Resources", value: resourceText(staged.resources) }] : []),
      ...(staged.modules?.length ? [{ label: "Modules", value: staged.modules.join(", ") }] : []),
      ...(staged.container ? [{ label: "Runtime image", value: staged.container }] : []),
    ]
  }
  return (
    <section aria-label="Dispatch preview" data-testid="dispatch-preview" style={card}>
      <strong style={heading}>This will run:</strong>
      <div style={box}>
        <span style={{ color: "var(--color-text-faint)", "user-select": "none" }}>$</span>
        <span>{props.staged.command}</span>
      </div>
      <div style={grid}>
        <For each={rows()}>
          {(row) => (
            <>
              <span>{row.label}</span>
              <strong style={{ "font-weight": "var(--font-weight-medium)", color: "var(--color-text)" }}>
                {row.value}
              </strong>
            </>
          )}
        </For>
      </div>
      <For each={previewNotes(props.staged)}>{(note) => <p style={line}>{note}</p>}</For>
    </section>
  )
}

const card: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  padding: "12px",
  border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
  "border-radius": "12px",
  background: "color-mix(in srgb, var(--color-bg-subtle) 82%, transparent)",
}

const heading: JSX.CSSProperties = {
  color: "var(--color-text)",
  "font-family": FONT_SANS,
  "font-size": "12px",
  "font-weight": "var(--font-weight-emphasis)",
}

const box: JSX.CSSProperties = {
  display: "flex",
  gap: "8px",
  padding: "10px",
  border: "1px solid color-mix(in srgb, var(--color-border) 74%, transparent)",
  "border-radius": "10px",
  background: "var(--color-bg)",
  color: "var(--color-text)",
  "font-family": FONT_MONO,
  "font-size": "12px",
  "line-height": 1.5,
  "white-space": "pre-wrap",
  "overflow-wrap": "anywhere",
}

const grid: JSX.CSSProperties = {
  display: "grid",
  "grid-template-columns": "128px minmax(0, 1fr)",
  gap: "5px 10px",
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "11px",
  "line-height": 1.4,
  "overflow-wrap": "anywhere",
}

const line: JSX.CSSProperties = {
  margin: 0,
  color: "var(--color-text-muted)",
  "font-family": FONT_SANS,
  "font-size": "11px",
  "line-height": 1.45,
}
