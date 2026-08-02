import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { toast } from "@/atlas/Toast"
import { DispatchPreview, dispatchReady } from "@/atlas/DispatchPreview"
import { createComputeJobsAPI, type Artifact, type Job, type Resources, type Status } from "@/atlas/ComputeJobsAPI"
import { useExecutionAuthority } from "@/atlas/use-execution-authority"
import {
  IconActivity,
  IconAlertCircle,
  IconCheckCircle,
  IconClock,
  IconCpu,
  IconCopy,
  IconDownload,
  IconPlus,
  IconRefresh,
  IconStop,
  IconTrash,
} from "@/atlas/shared/Icon"

const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])

export function ComputeJobs(props: { onEnsureSession?: () => Promise<string | undefined> } = {}): JSX.Element {
  const sdk = useSDK()
  const params = useParams()
  const api = createComputeJobsAPI(sdk.request)

  const [jobs, jobsApi] = createResource(api.list)
  const [selected, setSelected] = createSignal<string>()
  const [creating, setCreating] = createSignal(false)
  const [reviewed, setReviewed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [name, setName] = createSignal("")
  const [command, setCommand] = createSignal("")
  const [cwd, setCwd] = createSignal("")
  const authority = useExecutionAuthority("local_job")
  const [advanced, setAdvanced] = createSignal(false)
  const [cpus, setCpus] = createSignal("")
  const [gpus, setGpus] = createSignal("")
  const [memory, setMemory] = createSignal("")
  const [time, setTime] = createSignal("")
  const [partition, setPartition] = createSignal("")
  const [modules, setModules] = createSignal("")
  const [container, setContainer] = createSignal("")
  const [artifacts, setArtifacts] = createSignal("")
  const [checkpoint, setCheckpoint] = createSignal("")
  const current = createMemo(() => jobs()?.find((job) => job.id === selected()))
  const active = createMemo(() => jobs()?.filter((job) => !terminal.has(job.status)).length ?? 0)
  const [output, outputApi] = createResource(selected, async (id) => (await api.log(id)).log)

  createEffect(() => {
    const list = jobs()
    if (!list?.length) {
      setSelected(undefined)
      return
    }
    if (!selected() || !list.some((job) => job.id === selected())) setSelected(list[0].id)
  })

  createEffect(() => {
    if (active() === 0) return
    const timer = setInterval(() => {
      void jobsApi.refetch()
      if (selected() && current() && !terminal.has(current()!.status)) void outputApi.refetch()
    }, 2_500)
    onCleanup(() => clearInterval(timer))
  })

  const ensureSession = async () => {
    if (params.id && params.id !== "new") return params.id
    return props.onEnsureSession?.()
  }

  const begin = async () => {
    if (creating()) {
      setCreating(false)
      return
    }
    const id = await ensureSession()
    if (!id) {
      toast.error("job setup unavailable", "OpenScience could not create a session for this job.")
      return
    }
    setCreating(true)
  }

  const reset = () => {
    setName("")
    setCommand("")
    setCwd("")
    setAdvanced(false)
    setCpus("")
    setGpus("")
    setMemory("")
    setTime("")
    setPartition("")
    setModules("")
    setContainer("")
    setArtifacts("")
    setCheckpoint("")
    setReviewed(false)
    setCreating(false)
  }

  const resources = () => {
    const value = {
      cpus: number(cpus()),
      gpus: number(gpus()),
      memory_gb: number(memory()),
      time_minutes: number(time()),
      partition: partition().trim() || undefined,
    }
    return Object.values(value).some((item) => item !== undefined) ? value : undefined
  }

  const staged = () => {
    return {
      command: command().trim(),
      cwd: cwd().trim() || "Session workspace",
      resources: resources(),
      modules: listValue(modules()),
      container: container().trim() || undefined,
    }
  }

  const ready = () => dispatchReady({ name: name(), command: command(), reviewed: reviewed(), busy: busy() })

  const start = async () => {
    if (!ready()) return
    const sessionID = await ensureSession()
    if (!sessionID) {
      toast.error("job did not start", "OpenScience could not create a session for this job.")
      return
    }
    if (!authority.allowed()) {
      toast.error("job did not start", authority.message() ?? "This session cannot dispatch a research job.")
      return
    }
    setBusy(true)
    const next = await api
      .start({
        sessionID,
        name: name().trim(),
        command: command().trim(),
        cwd: cwd().trim() || undefined,
        target: { kind: "local" },
        resources: resources(),
        modules: listValue(modules()),
        container: container().trim() || undefined,
        artifacts: listValue(artifacts()),
        checkpoint: checkpoint().trim() || undefined,
      })
      .catch((error) => {
        toast.error("job did not start", error instanceof Error ? error.message : String(error))
        return undefined
      })
    setBusy(false)
    if (!next) return
    jobsApi.mutate((list) => [next, ...(list ?? []).filter((job) => job.id !== next.id)])
    setSelected(next.id)
    reset()
    void jobsApi.refetch()
  }

  const cancel = async (job: Job) => {
    setBusy(true)
    const next = await api.cancel(job.id).catch((error) => {
      toast.error("job did not cancel", error instanceof Error ? error.message : String(error))
      return undefined
    })
    setBusy(false)
    if (!next) return
    jobsApi.mutate((list) => list?.map((item) => (item.id === next.id ? next : item)))
    void outputApi.refetch()
  }

  const rerun = (job: Job) => {
    if (job.target.kind !== "local") {
      toast.error(
        "remote rerun unavailable",
        "SSH dispatch stays disabled until staging, reattachment, cancellation, logs, and outputs pass real-host validation.",
      )
      return
    }
    setName(job.name)
    setCommand(job.command)
    setCwd("")
    setCpus(job.resources?.cpus?.toString() ?? "")
    setGpus(job.resources?.gpus?.toString() ?? "")
    setMemory(job.resources?.memory_gb?.toString() ?? "")
    setTime(job.resources?.time_minutes?.toString() ?? "")
    setPartition(job.resources?.partition ?? "")
    setModules(job.modules?.join(", ") ?? "")
    setContainer(job.container ?? "")
    setArtifacts(job.artifact_patterns?.join(", ") ?? "")
    setCheckpoint(job.checkpoint_path ?? "")
    setAdvanced(
      !!(job.resources || job.modules?.length || job.container || job.artifact_patterns?.length || job.checkpoint_path),
    )
    setReviewed(false)
    setCreating(true)
  }

  const save = (name: string, value: string, type = "text/plain") => {
    const url = URL.createObjectURL(new Blob([value], { type }))
    const link = document.createElement("a")
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  }

  const clear = async () => {
    setBusy(true)
    await api
      .clear()
      .catch((error) => toast.error("jobs were not cleared", error instanceof Error ? error.message : String(error)))
    setBusy(false)
    await jobsApi.refetch()
  }

  return (
    <div class="compute-jobs" style={shell}>
      <div style={header}>
        <div style={{ display: "flex", "align-items": "center", gap: "9px", "min-width": 0 }}>
          <span style={mark}>
            <IconCpu size={15} strokeWidth={1.5} />
          </span>
          <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "min-width": 0 }}>
            <span style={title}>Research jobs</span>
            <span style={subtitle}>
              {active() ? `${active()} active in this project` : "Runs stay with this project"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          <Action title="Refresh jobs" onClick={() => void jobsApi.refetch()}>
            <IconRefresh size={15} />
          </Action>
          <Action
            title={creating() ? "Close job setup" : "New job"}
            active={creating()}
            disabled={busy()}
            onClick={() => void begin()}
          >
            <IconPlus size={16} />
          </Action>
        </div>
      </div>

      <Show when={jobs.error}>
        <div role="alert" style={errorBox}>
          <span style={{ flex: 1 }}>
            Compute jobs are unavailable. {jobs.error instanceof Error ? jobs.error.message : String(jobs.error)}
          </span>
          <button type="button" style={secondaryButton} onClick={() => void jobsApi.refetch()}>
            Retry
          </button>
        </div>
      </Show>

      <Show when={authority.message()}>
        {(message) => (
          <div role={authority.decision.error ? "alert" : "status"} style={authorityBox}>
            {message()}
          </div>
        )}
      </Show>

      <Show when={creating()}>
        <form
          style={form}
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <div style={formHeader}>
            <strong style={formTitle}>New research job</strong>
            <span style={formCopy}>
              Configure one command, review exactly what will run, then dispatch. Results stay with this project.
            </span>
          </div>
          <Field label="Job name">
            <input
              aria-label="Job name"
              style={input}
              value={name()}
              placeholder="Experiment name"
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </Field>
          <div
            style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}
          >
            <Field label="Run location">
              <input aria-label="Run location" style={input} value="This computer" readOnly />
            </Field>
            <Field label="Working directory">
              <input
                aria-label="Working directory"
                style={input}
                value={cwd()}
                placeholder="Project directory"
                onInput={(event) => setCwd(event.currentTarget.value)}
              />
            </Field>
          </div>
          <Field label="Command">
            <textarea
              aria-label="Command"
              style={{ ...input, height: "84px", resize: "vertical", "line-height": 1.5, padding: "9px 10px" }}
              value={command()}
              placeholder={"python train.py --config config.yaml"}
              spellcheck={false}
              onInput={(event) => setCommand(event.currentTarget.value)}
            />
          </Field>
          <button
            type="button"
            aria-expanded={advanced()}
            style={advancedToggle}
            onClick={() => setAdvanced((value) => !value)}
          >
            <span>Resources and reproducibility</span>
            <span>{advanced() ? "Hide" : "Configure"}</span>
          </button>
          <Show when={advanced()}>
            <div style={advancedGrid}>
              <Field label="CPU">
                <input
                  aria-label="CPU cores"
                  style={input}
                  type="number"
                  min="1"
                  placeholder="Cores"
                  value={cpus()}
                  onInput={(event) => setCpus(event.currentTarget.value)}
                />
              </Field>
              <Field label="GPU">
                <input
                  aria-label="GPUs"
                  style={input}
                  type="number"
                  min="0"
                  placeholder="Count"
                  value={gpus()}
                  onInput={(event) => setGpus(event.currentTarget.value)}
                />
              </Field>
              <Field label="Memory">
                <input
                  aria-label="Memory in GB"
                  style={input}
                  type="number"
                  min="0.1"
                  step="0.1"
                  placeholder="GB"
                  value={memory()}
                  onInput={(event) => setMemory(event.currentTarget.value)}
                />
              </Field>
              <Field label="Limit">
                <input
                  aria-label="Time limit in minutes"
                  style={input}
                  type="number"
                  min="1"
                  placeholder="Minutes"
                  value={time()}
                  onInput={(event) => setTime(event.currentTarget.value)}
                />
              </Field>
            </div>
            <Field label="Queue or partition">
              <input
                aria-label="Queue or partition"
                style={input}
                value={partition()}
                placeholder="Optional queue or partition"
                onInput={(event) => setPartition(event.currentTarget.value)}
              />
            </Field>
            <Field label="Environment modules">
              <input
                aria-label="Environment modules"
                style={input}
                value={modules()}
                placeholder="cuda/12.4, python/3.12"
                onInput={(event) => setModules(event.currentTarget.value)}
              />
            </Field>
            <Field label="Runtime image">
              <input
                aria-label="Runtime image"
                style={input}
                value={container()}
                placeholder="Optional container image"
                onInput={(event) => setContainer(event.currentTarget.value)}
              />
            </Field>
            <Field label="Files to capture">
              <input
                aria-label="Artifact patterns"
                style={input}
                value={artifacts()}
                placeholder="outputs/**/*.csv, figures/*.png"
                onInput={(event) => setArtifacts(event.currentTarget.value)}
              />
            </Field>
            <Field label="Checkpoint">
              <input
                aria-label="Checkpoint path"
                style={input}
                value={checkpoint()}
                placeholder="checkpoints/latest.ckpt"
                onInput={(event) => setCheckpoint(event.currentTarget.value)}
              />
            </Field>
            <span style={advancedHint}>
              Project runs capture git state, lockfiles, file checksums, and the checkpoint automatically.
            </span>
          </Show>
          <Show when={reviewed() && command().trim()}>
            <DispatchPreview staged={staged()} />
          </Show>
          <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px", "padding-top": "2px" }}>
            <button type="button" style={secondaryButton} onClick={reset}>
              Cancel
            </button>
            <Show when={!reviewed()}>
              <button
                type="button"
                style={secondaryButton}
                disabled={!name().trim() || !command().trim()}
                onClick={() => setReviewed(true)}
              >
                Review command
              </button>
            </Show>
            <button
              type="submit"
              style={primaryButton}
              title={authority.message() ?? (reviewed() ? undefined : "Review the exact command before dispatching")}
              disabled={!ready() || !authority.allowed()}
            >
              {busy() ? "Dispatching…" : "Dispatch"}
            </button>
          </div>
        </form>
      </Show>

      <Show when={!creating()}>
        <>
          <Show
            when={(jobs()?.length ?? 0) > 0}
            fallback={
              <div style={empty}>
                <span style={emptyMark}>
                  <IconActivity size={20} strokeWidth={1.5} />
                </span>
                <strong style={emptyTitle}>No jobs in this project</strong>
                <span style={emptyCopy}>
                  Run a command and keep its output, captured files, and reproducibility record together.
                </span>
                <button
                  type="button"
                  style={primaryButton}
                  title="Create a research job"
                  disabled={busy()}
                  onClick={() => void begin()}
                >
                  Create first job
                </button>
              </div>
            }
          >
            <div style={listHeader}>
              <span>Recent runs</span>
              <button type="button" disabled={busy()} style={textButton} onClick={() => void clear()}>
                <IconTrash size={14} />
                Clear finished
              </button>
            </div>
            <div style={list}>
              <For each={jobs()}>
                {(job) => (
                  <button
                    type="button"
                    onClick={() => setSelected(job.id)}
                    style={{
                      ...row,
                      background:
                        selected() === job.id
                          ? "color-mix(in srgb, var(--color-surface-solid) 92%, var(--color-accent) 8%)"
                          : "transparent",
                      "border-color":
                        selected() === job.id
                          ? "color-mix(in srgb, var(--color-border-strong) 72%, transparent)"
                          : "transparent",
                    }}
                  >
                    <StatusIcon status={job.status} />
                    <span style={{ display: "flex", "flex-direction": "column", gap: "4px", "min-width": 0, flex: 1 }}>
                      <span
                        style={{
                          color: "var(--color-text)",
                          "font-size": "14px",
                          "font-weight": 600,
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {job.name}
                      </span>
                      <span
                        style={{
                          color: "var(--color-text-faint)",
                          "font-size": "12px",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {job.target_label} · {job.status}
                      </span>
                    </span>
                    <span style={{ color: "var(--color-text-faint)", "font-size": "11px", "white-space": "nowrap" }}>
                      {age(job.created_at)}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={current()}>
            {(job) => (
              <div style={detail}>
                <div style={{ display: "flex", "align-items": "flex-start", gap: "12px" }}>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "4px", flex: 1, "min-width": 0 }}>
                    <span
                      style={{
                        color: "var(--color-text)",
                        "font-family": FONT_SANS,
                        "font-size": "15px",
                        "font-weight": 650,
                        "line-height": 1.25,
                      }}
                    >
                      {job().name}
                    </span>
                    <span style={{ color: "var(--color-text-faint)", "font-family": FONT_MONO, "font-size": "11px" }}>
                      {job().id} · {duration(job())}
                    </span>
                  </div>
                  <Show when={!terminal.has(job().status) && job().target.kind === "local"}>
                    <Action title="Cancel job" onClick={() => void cancel(job())}>
                      <IconStop size={16} />
                    </Action>
                  </Show>
                  <button
                    type="button"
                    style={secondaryButton}
                    disabled={job().target.kind !== "local"}
                    title={
                      job().target.kind === "local"
                        ? "Rerun this command locally"
                        : "Remote dispatch is unavailable until its full lifecycle passes real-host validation"
                    }
                    onClick={() => rerun(job())}
                  >
                    Rerun
                  </button>
                </div>
                <div style={commandBox}>
                  <span style={{ color: "var(--color-text-faint)", "user-select": "none" }}>$</span>
                  <span>{job().command}</span>
                </div>
                <Show when={job().cwd}>
                  <div style={meta}>Working directory · {job().cwd}</div>
                </Show>
                <Show when={resourceLabel(job())}>{(value) => <div style={meta}>Resources · {value()}</div>}</Show>
                <Show when={job().modules?.length}>
                  <div style={meta}>Modules · {job().modules?.join(", ")}</div>
                </Show>
                <Show when={job().container}>
                  <div style={meta}>Runtime image · {job().container}</div>
                </Show>
                <Show when={job().artifacts?.length || job().checkpoint}>
                  <section style={captureCard}>
                    <div style={cardTitle}>
                      <span>Captured outputs</span>
                      <span>{(job().artifacts?.length ?? 0) + (job().checkpoint ? 1 : 0)} verified</span>
                    </div>
                    <Show when={job().checkpoint}>{(item) => <ArtifactRow item={item()} label="Checkpoint" />}</Show>
                    <For each={job().artifacts}>{(item) => <ArtifactRow item={item} />}</For>
                  </section>
                </Show>
                <Show when={job().reproducibility}>
                  {(manifest) => (
                    <section style={captureCard}>
                      <div style={cardTitle}>
                        <span>Reproducibility</span>
                        <span>{manifest().git?.dirty ? "Working tree changed" : "Captured"}</span>
                      </div>
                      <div style={manifestGrid}>
                        <span>Runtime</span>
                        <strong>
                          {manifest().platform} · {manifest().arch} · Bun {manifest().bun}
                        </strong>
                        <span>Code</span>
                        <strong>
                          {manifest().git?.branch ?? "No git branch"}
                          {manifest().git?.commit ? ` · ${manifest().git?.commit?.slice(0, 8)}` : ""}
                          {manifest().git?.dirty ? " · dirty" : ""}
                        </strong>
                        <span>Environment</span>
                        <strong>
                          {manifest().lockfiles.length
                            ? manifest()
                                .lockfiles.map((file) => file.path)
                                .join(", ")
                            : "No lockfile found"}
                        </strong>
                      </div>
                      <button
                        type="button"
                        style={exportButton}
                        onClick={() =>
                          save(
                            `${safeName(job().name)}-reproducibility.json`,
                            JSON.stringify(manifest(), null, 2),
                            "application/json",
                          )
                        }
                      >
                        <IconDownload size={16} />
                        Export manifest
                      </button>
                    </section>
                  )}
                </Show>
                <div style={logHeader}>
                  <span>Output</span>
                  <span style={{ display: "inline-flex", "align-items": "center", gap: "8px" }}>
                    <span>{output.loading ? "Syncing…" : `${output()?.length ?? 0} bytes`}</span>
                    <button
                      type="button"
                      title="Copy command"
                      aria-label="Copy command"
                      style={iconButton}
                      onClick={() => void navigator.clipboard.writeText(job().command)}
                    >
                      <IconCopy size={14} />
                    </button>
                    <button
                      type="button"
                      title="Download log"
                      aria-label="Download log"
                      style={iconButton}
                      onClick={() => save(`${safeName(job().name)}.log`, output() ?? "")}
                    >
                      <IconDownload size={14} />
                    </button>
                  </span>
                </div>
                <pre style={log}>
                  {output() || (terminal.has(job().status) ? "No output was captured." : "Waiting for output…")}
                </pre>
                <Show when={job().error}>
                  <div style={errorBox}>{job().error}</div>
                </Show>
                <Show when={job().capture_error}>
                  <div style={errorBox}>
                    The run finished, but reproducibility capture failed: {job().capture_error}
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </>
      </Show>
    </div>
  )
}

function Field(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
      <span style={{ color: "var(--color-text-muted)", "font-family": FONT_SANS, "font-size": "12px" }}>
        {props.label}
      </span>
      {props.children}
    </label>
  )
}

function ArtifactRow(props: { item: Artifact; label?: string }): JSX.Element {
  return (
    <div style={artifactRow}>
      <span style={{ display: "flex", "flex-direction": "column", gap: "4px", "min-width": 0, flex: 1 }}>
        <strong
          style={{
            color: "var(--color-text)",
            "font-family": FONT_MONO,
            "font-size": "13px",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
          title={props.item.path}
        >
          {props.item.path}
        </strong>
        <span style={{ color: "var(--color-text-faint)", "font-family": FONT_MONO, "font-size": "11px" }}>
          {props.label ? `${props.label} · ` : ""}
          {bytes(props.item.size)} · sha256 {props.item.sha256.slice(0, 10)}
        </span>
      </span>
      <IconCheckCircle size={15} strokeWidth={1.6} />
    </div>
  )
}

function StatusIcon(props: { status: Status }): JSX.Element {
  const config = () => {
    if (props.status === "succeeded") return { color: "var(--color-success)", icon: IconCheckCircle }
    if (props.status === "failed") return { color: "var(--color-danger)", icon: IconAlertCircle }
    if (props.status === "interrupted") return { color: "var(--color-warning)", icon: IconAlertCircle }
    if (props.status === "cancelled") return { color: "var(--color-text-faint)", icon: IconStop }
    if (props.status === "running") return { color: "var(--color-accent)", icon: IconActivity }
    return { color: "var(--color-text-muted)", icon: IconClock }
  }
  return (
    <span style={{ color: config().color, display: "inline-flex", "flex-shrink": 0 }}>
      <Dynamic component={config().icon} size={16} strokeWidth={1.7} />
    </span>
  )
}

function Action(props: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        all: "unset",
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.45 : 1,
        width: "32px",
        height: "32px",
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        "border-radius": "8px",
        border: "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
        background: props.active
          ? "color-mix(in srgb, var(--color-accent-subtle) 88%, transparent)"
          : "var(--color-bg-elevated)",
        color: props.active ? "var(--color-accent)" : "var(--color-text-muted)",
        "box-sizing": "border-box",
        transition: "background-color 140ms ease, border-color 140ms ease, color 140ms ease",
      }}
    >
      {props.children}
    </button>
  )
}

function number(value: string): number | undefined {
  if (!value.trim()) return
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function listValue(value: string): string[] | undefined {
  const values = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return values.length ? values : undefined
}

function resourceLabel(job: Job): string | undefined {
  const resources = job.resources
  if (!resources) return
  const values = [
    resources.cpus ? `${resources.cpus} CPU` : undefined,
    resources.gpus !== undefined ? `${resources.gpus} GPU` : undefined,
    resources.memory_gb ? `${resources.memory_gb} GB` : undefined,
    resources.time_minutes ? `${resources.time_minutes} min` : undefined,
    resources.partition,
  ].filter((value): value is string => !!value)
  return values.length ? values.join(" · ") : undefined
}

function bytes(value: number): string {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`
  return `${(value / 1_000_000_000).toFixed(1)} GB`
}

function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "compute-job"
  )
}

function age(value: string): string {
  const delta = Math.max(0, Date.now() - Date.parse(value))
  if (delta < 60_000) return "now"
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  return `${Math.floor(delta / 86_400_000)}d`
}

function duration(job: Job): string {
  if (!job.started_at) return job.status
  const end = job.completed_at ? Date.parse(job.completed_at) : Date.now()
  const seconds = Math.max(0, Math.round((end - Date.parse(job.started_at)) / 1_000))
  if (seconds < 60) return `${job.status} · ${seconds}s`
  return `${job.status} · ${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const shell: JSX.CSSProperties = {
  flex: 1,
  "min-height": 0,
  display: "flex",
  "flex-direction": "column",
  overflow: "hidden",
  background: "var(--color-bg)",
  "font-family": FONT_SANS,
  "font-size": "14px",
}

const header: JSX.CSSProperties = {
  "min-height": "48px",
  "box-sizing": "border-box",
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "10px",
  padding: "7px 10px 7px 12px",
  "border-bottom": "1px solid color-mix(in srgb, var(--color-border) 68%, transparent)",
  background: "var(--color-bg)",
  "flex-shrink": 0,
}

const mark: JSX.CSSProperties = {
  width: "32px",
  height: "32px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "border-radius": "8px",
  background: "color-mix(in srgb, var(--color-accent) 10%, var(--color-surface-solid))",
  color: "var(--color-accent)",
  "flex-shrink": 0,
}

const title: JSX.CSSProperties = {
  color: "var(--color-text)",
  "font-size": "15px",
  "font-weight": 600,
  "letter-spacing": "-0.01em",
  "line-height": 1.2,
}

const subtitle: JSX.CSSProperties = {
  color: "var(--color-text-faint)",
  "font-family": FONT_SANS,
  "font-size": "11px",
  "line-height": 1.3,
}

const form: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  margin: "8px 10px 0",
  padding: "12px",
  "max-height": "min(68vh, 680px)",
  overflow: "auto",
  border: "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
  "border-radius": "12px",
  background: "color-mix(in srgb, var(--color-surface-solid) 94%, var(--color-bg) 6%)",
  "box-shadow": "none",
  "flex-shrink": 1,
}

const formHeader: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "2px",
  "padding-bottom": "2px",
}

const formTitle: JSX.CSSProperties = {
  color: "var(--color-text)",
  "font-size": "15px",
  "font-weight": 600,
  "letter-spacing": "-0.01em",
}

const formCopy: JSX.CSSProperties = {
  color: "var(--color-text-muted)",
  "font-size": "12px",
  "line-height": 1.4,
}

const input: JSX.CSSProperties = {
  width: "100%",
  height: "36px",
  "box-sizing": "border-box",
  border: "1px solid color-mix(in srgb, var(--color-border) 84%, transparent)",
  "border-radius": "8px",
  background: "var(--color-bg)",
  color: "var(--color-text)",
  padding: "0 10px",
  outline: "2px solid transparent",
  "outline-offset": "1px",
  "font-family": FONT_SANS,
  "font-size": "13px",
  transition: "border-color 140ms ease, outline-color 140ms ease, background-color 140ms ease",
}

const advancedToggle: JSX.CSSProperties = {
  cursor: "pointer",
  width: "100%",
  "min-height": "36px",
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "10px",
  border: "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
  "border-radius": "8px",
  background: "color-mix(in srgb, var(--color-bg-subtle) 82%, transparent)",
  color: "var(--color-text-muted)",
  "font-family": FONT_SANS,
  "font-size": "13px",
  "font-weight": 550,
  padding: "0 10px",
  "text-align": "left",
}

const advancedGrid: JSX.CSSProperties = {
  display: "grid",
  "grid-template-columns": "repeat(auto-fit, minmax(104px, 1fr))",
  gap: "10px",
}

const advancedHint: JSX.CSSProperties = {
  color: "var(--color-text-faint)",
  "font-family": FONT_SANS,
  "font-size": "11px",
  "line-height": 1.4,
  padding: "2px 2px 0",
}

const primaryButton: JSX.CSSProperties = {
  cursor: "pointer",
  border: "1px solid var(--color-accent)",
  "border-radius": "8px",
  background: "var(--color-accent)",
  color: "var(--color-bg)",
  "min-height": "34px",
  padding: "0 13px",
  "font-family": FONT_SANS,
  "font-size": "13px",
  "font-weight": 600,
  transition: "filter 140ms ease, transform 140ms ease",
}

const secondaryButton: JSX.CSSProperties = {
  cursor: "pointer",
  border: "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
  "border-radius": "8px",
  background: "var(--color-bg-elevated)",
  color: "var(--color-text-muted)",
  "min-height": "32px",
  padding: "0 10px",
  "font-family": FONT_SANS,
  "font-size": "13px",
  "font-weight": 550,
}

const empty: JSX.CSSProperties = {
  flex: 1,
  "min-height": 0,
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  "justify-content": "center",
  gap: "10px",
  padding: "36px 24px 44px",
  color: "var(--color-text-muted)",
  "font-size": "13px",
  "line-height": 1.5,
  "text-align": "center",
}

const emptyMark: JSX.CSSProperties = {
  width: "40px",
  height: "40px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "border-radius": "10px",
  background: "color-mix(in srgb, var(--color-surface-solid) 94%, var(--color-accent) 6%)",
  border: "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
  color: "var(--color-accent)",
}

const emptyTitle: JSX.CSSProperties = {
  color: "var(--color-text)",
  "font-size": "15px",
  "font-weight": 600,
  "letter-spacing": "-0.01em",
}

const emptyCopy: JSX.CSSProperties = {
  "max-width": "360px",
  color: "var(--color-text-muted)",
  "font-size": "13px",
  "line-height": 1.5,
}

const listHeader: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "12px",
  padding: "10px 12px 4px",
  color: "var(--color-text-faint)",
  "font-family": FONT_SANS,
  "font-size": "11px",
  "font-weight": 600,
}

const textButton: JSX.CSSProperties = {
  cursor: "pointer",
  display: "inline-flex",
  "align-items": "center",
  gap: "6px",
  "min-height": "32px",
  padding: "0 8px",
  border: 0,
  "border-radius": "8px",
  background: "transparent",
  color: "var(--color-text-muted)",
  "font-family": FONT_SANS,
  "font-size": "12px",
}

const list: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "2px",
  padding: "0 8px 8px",
  "max-height": "216px",
  overflow: "auto",
  "flex-shrink": 0,
  "border-bottom": "1px solid color-mix(in srgb, var(--color-border) 66%, transparent)",
}

const row: JSX.CSSProperties = {
  cursor: "pointer",
  width: "100%",
  "min-height": "44px",
  display: "flex",
  "align-items": "center",
  gap: "8px",
  padding: "5px 8px",
  border: "1px solid transparent",
  "border-radius": "8px",
  "text-align": "left",
  "font-family": FONT_SANS,
  "font-size": "14px",
  transition: "background-color 140ms ease, border-color 140ms ease",
}

const detail: JSX.CSSProperties = {
  flex: 1,
  "min-height": 0,
  overflow: "auto",
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  padding: "12px",
  background: "var(--color-bg)",
}

const commandBox: JSX.CSSProperties = {
  display: "flex",
  gap: "8px",
  padding: "10px",
  border: "1px solid color-mix(in srgb, var(--color-border) 74%, transparent)",
  "border-radius": "10px",
  background: "var(--color-bg-subtle)",
  color: "var(--color-text-muted)",
  "font-family": FONT_MONO,
  "font-size": "12px",
  "line-height": 1.5,
  "white-space": "pre-wrap",
  "overflow-wrap": "anywhere",
}

const meta: JSX.CSSProperties = {
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "11px",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
}

const captureCard: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  padding: "12px",
  border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
  "border-radius": "12px",
  background: "color-mix(in srgb, var(--color-bg-subtle) 82%, transparent)",
}

const cardTitle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "10px",
  color: "var(--color-text-faint)",
  "font-family": FONT_SANS,
  "font-size": "11px",
  "font-weight": 600,
}

const artifactRow: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "9px",
  color: "var(--color-success)",
  padding: "8px",
  border: "1px solid color-mix(in srgb, var(--color-border) 68%, transparent)",
  "border-radius": "8px",
  background: "var(--color-bg)",
}

const manifestGrid: JSX.CSSProperties = {
  display: "grid",
  "grid-template-columns": "92px minmax(0, 1fr)",
  gap: "7px 10px",
  color: "var(--color-text-faint)",
  "font-family": FONT_MONO,
  "font-size": "11px",
  "line-height": 1.4,
}

const exportButton: JSX.CSSProperties = {
  cursor: "pointer",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  gap: "6px",
  "min-height": "32px",
  padding: "0 10px",
  border: "1px solid color-mix(in srgb, var(--color-border) 78%, transparent)",
  "border-radius": "8px",
  background: "var(--color-bg)",
  color: "var(--color-text-muted)",
  "font-family": FONT_SANS,
  "font-size": "12px",
  "font-weight": 550,
}

const logHeader: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "10px",
  color: "var(--color-text-faint)",
  "font-family": FONT_SANS,
  "font-size": "11px",
  "font-weight": 600,
  "margin-top": "4px",
}

const iconButton: JSX.CSSProperties = {
  cursor: "pointer",
  width: "32px",
  height: "32px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  border: "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
  "border-radius": "8px",
  background: "var(--color-bg-elevated)",
  color: "var(--color-text-faint)",
}

const log: JSX.CSSProperties = {
  flex: 1,
  "min-height": "120px",
  margin: 0,
  padding: "12px",
  border: "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
  "border-radius": "12px",
  background: "#101411",
  color: "#c9d4cc",
  "font-family": FONT_MONO,
  "font-size": "12px",
  "line-height": 1.55,
  "white-space": "pre-wrap",
  "overflow-wrap": "anywhere",
  overflow: "auto",
}

const errorBox: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "9px",
  margin: "8px 10px 0",
  padding: "10px",
  "border-radius": "10px",
  border: "1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)",
  background: "color-mix(in srgb, var(--color-danger) 8%, transparent)",
  color: "var(--color-danger)",
  "font-family": FONT_SANS,
  "font-size": "12px",
  "line-height": 1.4,
}

const authorityBox: JSX.CSSProperties = {
  margin: "8px 10px 0",
  padding: "8px 10px",
  "border-radius": "8px",
  border: "1px solid color-mix(in srgb, var(--color-warning) 20%, var(--color-border))",
  background: "color-mix(in srgb, var(--color-warning) 7%, var(--color-bg))",
  color: "var(--color-text-muted)",
  "font-family": FONT_SANS,
  "font-size": "12px",
  "line-height": 1.4,
}
