import { For, Show, createEffect, createMemo, createResource, onCleanup, type JSX, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { toast } from "@/atlas/Toast"
import { DispatchPreview, dispatchReady } from "@/atlas/DispatchPreview"
import {
  createComputeJobsAPI,
  type Artifact,
  type Job,
  type Plan,
  type Resources,
  type Status,
  serial,
  stableJobs,
} from "@/atlas/ComputeJobsAPI"
import { ledger, type RunTone } from "@/atlas/run-ledger"
import { useExecutionAuthority } from "@/atlas/use-execution-authority"
import {
  IconActivity,
  IconAlertCircle,
  IconCheckCircle,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCpu,
  IconCopy,
  IconDownload,
  IconPlus,
  IconStop,
  IconTrash,
} from "@/atlas/shared/Icon"

const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])

export function ComputeJobs(
  props: {
    onEnsureSession?: () => Promise<string | undefined>
    onActiveChange?: (count: number) => void
    // The surface shows a total beside the tab label. It cannot poll for it
    // while this panel is open without duplicating this panel's own 2.5s poll,
    // so the count comes from here instead.
    onTotalChange?: (count: number) => void
    manual?: boolean
  } = {},
): JSX.Element {
  const sdk = useSDK()
  const params = useParams()
  const api = createComputeJobsAPI(sdk.request)

  const cache: { value?: Job[] } = {}
  const [jobs, jobsApi] = createResource(async () => {
    const value = stableJobs(cache.value, await api.list())
    cache.value = value
    return value
  })
  const seeded = { value: false }
  const [state, setState] = createStore({
    selected: undefined as string | undefined,
    creating: false,
    reviewed: false,
    busy: false,
    name: "",
    command: "",
    cwd: "",
    target: "local" as "local" | "modal",
    image: "",
    gpu: "T4",
    uploads: "",
    plan: undefined as Plan | undefined,
    stamp: "",
    advanced: false,
    cpus: "",
    gpus: "",
    memory: "",
    time: "",
    partition: "",
    modules: "",
    container: "",
    artifacts: "",
    checkpoint: "",
    output: "",
    events: "",
    outputBusy: false,
    eventsBusy: false,
  })
  const selected = () => state.selected
  const setSelected = (value: string | undefined | ((prior: string | undefined) => string | undefined)) => {
    const next = value instanceof Function ? value(state.selected) : value
    setState("selected", next)
    return next
  }
  const creating = () => state.creating
  const setCreating: Setter<boolean> = (value) => setState("creating", value)
  const reviewed = () => state.reviewed
  const setReviewed: Setter<boolean> = (value) => setState("reviewed", value)
  const busy = () => state.busy
  const setBusy: Setter<boolean> = (value) => setState("busy", value)
  const name = () => state.name
  const setName: Setter<string> = (value) => setState("name", value)
  const command = () => state.command
  const setCommand: Setter<string> = (value) => setState("command", value)
  const cwd = () => state.cwd
  const setCwd: Setter<string> = (value) => setState("cwd", value)
  const target = () => state.target
  const setTarget: Setter<"local" | "modal"> = (value) => setState("target", value)
  const image = () => state.image
  const setImage: Setter<string> = (value) => setState("image", value)
  const gpu = () => state.gpu
  const setGpu: Setter<string> = (value) => setState("gpu", value)
  const uploads = () => state.uploads
  const setUploads: Setter<string> = (value) => setState("uploads", value)
  const plan = () => state.plan
  const setPlan = (value: Plan | undefined) => {
    setState("plan", value)
    return value
  }
  const stamp = () => state.stamp
  const setStamp: Setter<string> = (value) => setState("stamp", value)
  const advanced = () => state.advanced
  const setAdvanced: Setter<boolean> = (value) => setState("advanced", value)
  const cpus = () => state.cpus
  const setCpus: Setter<string> = (value) => setState("cpus", value)
  const gpus = () => state.gpus
  const setGpus: Setter<string> = (value) => setState("gpus", value)
  const memory = () => state.memory
  const setMemory: Setter<string> = (value) => setState("memory", value)
  const time = () => state.time
  const setTime: Setter<string> = (value) => setState("time", value)
  const partition = () => state.partition
  const setPartition: Setter<string> = (value) => setState("partition", value)
  const modules = () => state.modules
  const setModules: Setter<string> = (value) => setState("modules", value)
  const container = () => state.container
  const setContainer: Setter<string> = (value) => setState("container", value)
  const artifacts = () => state.artifacts
  const setArtifacts: Setter<string> = (value) => setState("artifacts", value)
  const checkpoint = () => state.checkpoint
  const setCheckpoint: Setter<string> = (value) => setState("checkpoint", value)
  const output = () => state.output
  const setOutput: Setter<string> = (value) => setState("output", value)
  const events = () => state.events
  const setEvents: Setter<string> = (value) => setState("events", value)
  const outputBusy = () => state.outputBusy
  const setOutputBusy: Setter<boolean> = (value) => setState("outputBusy", value)
  const eventsBusy = () => state.eventsBusy
  const setEventsBusy: Setter<boolean> = (value) => setState("eventsBusy", value)
  const authority = useExecutionAuthority(() => (target() === "modal" ? "remote_job" : "local_job"))
  const current = createMemo(() => jobs()?.find((job) => job.id === selected()))
  const active = createMemo(() => jobs()?.filter((job) => !terminal.has(job.status)).length ?? 0)

  createEffect(() => props.onActiveChange?.(active()))
  createEffect(() => {
    const list = jobs()
    if (list) props.onTotalChange?.(list.length)
  })

  const refresh = async (report = false) => {
    if (!cache.value) {
      await jobsApi.refetch()
      return
    }
    const next = await api.list().catch((error) => {
      if (report) toast.error("jobs could not be refreshed", error instanceof Error ? error.message : String(error))
      return undefined
    })
    if (!next) return
    const value = stableJobs(cache.value, next)
    if (value === cache.value) return
    cache.value = value
    jobsApi.mutate(value)
  }

  const streams = serial(async (id: string) => {
    setOutputBusy(true)
    setEventsBusy(true)
    await Promise.all([
      api
        .log(id)
        .then((value) => value.log)
        .catch(() => undefined),
      api
        .events(id)
        .then((value) => value.events)
        .catch(() => undefined),
    ])
      .then(([log, lifecycle]) => {
        if (selected() !== id) return
        if (log !== undefined && log !== output()) setOutput(log)
        if (lifecycle !== undefined && lifecycle !== events()) setEvents(lifecycle)
      })
      .finally(() => {
        setOutputBusy(false)
        setEventsBusy(false)
      })
  })

  createEffect(() => {
    const list = jobs()
    if (!list?.length) {
      setSelected(undefined)
      seeded.value = false
      return
    }
    if (selected() && !list.some((job) => job.id === selected())) setSelected(undefined)
    if (seeded.value) return
    seeded.value = true
    setSelected(list.find((job) => !terminal.has(job.status))?.id ?? list[0].id)
  })

  createEffect(() => {
    const id = selected()
    setOutput("")
    setEvents("")
    if (id) void streams(id)
  })

  createEffect(() => {
    const id = selected()
    const status = current()?.status
    if (id && status && terminal.has(status)) void streams(id)
  })

  createEffect(() => {
    const timer = setInterval(() => {
      void refresh()
      const id = selected()
      const job = current()
      if (id && job && !terminal.has(job.status)) void streams(id)
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
    setTarget("local")
    setImage("")
    setGpu("T4")
    setUploads("")
    setPlan(undefined)
    setStamp("")
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
      target: target() === "modal" ? "Modal" : "This computer",
      resources: resources(),
      modules: listValue(modules()),
      container: container().trim() || undefined,
    }
  }

  const signature = () =>
    JSON.stringify({
      name: name().trim(),
      command: command().trim(),
      cwd: cwd().trim(),
      target: target(),
      resources: resources(),
      modules: listValue(modules()),
      container: container().trim(),
      artifacts: listValue(artifacts()),
      checkpoint: checkpoint().trim(),
      uploads: listValue(uploads()),
      image: image().trim(),
      gpu: gpu().trim(),
    })

  const approved = () => reviewed() && stamp() === signature()
  const ready = () => dispatchReady({ name: name(), command: command(), reviewed: approved(), busy: busy() })

  const review = async () => {
    if (target() === "local") {
      setPlan(undefined)
      setStamp(signature())
      setReviewed(true)
      return
    }
    const sessionID = await ensureSession()
    if (!sessionID) return
    setBusy(true)
    const next = await api
      .plan({
        sessionID,
        name: name().trim(),
        command: command().trim(),
        cwd: cwd().trim() || undefined,
        target: { kind: "modal" },
        resources: resources(),
        artifacts: listValue(artifacts()),
        checkpoint: checkpoint().trim() || undefined,
        uploads: listValue(uploads()),
        image: image().trim() || undefined,
        gpu: gpu().trim(),
      })
      .catch((error) => {
        toast.error("Modal plan unavailable", error instanceof Error ? error.message : String(error))
        return undefined
      })
    setBusy(false)
    if (!next) return
    setPlan(next)
    setStamp(signature())
    setReviewed(true)
  }

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
        target: target() === "modal" ? { kind: "modal" } : { kind: "local" },
        resources: resources(),
        modules: listValue(modules()),
        container: container().trim() || undefined,
        artifacts: listValue(artifacts()),
        checkpoint: checkpoint().trim() || undefined,
        uploads: target() === "modal" ? listValue(uploads()) : undefined,
        image: target() === "modal" ? image().trim() || undefined : undefined,
        gpu: target() === "modal" ? gpu().trim() : undefined,
        approval: target() === "modal" ? plan()?.digest : undefined,
      })
      .catch((error) => {
        toast.error("job did not start", error instanceof Error ? error.message : String(error))
        return undefined
      })
    setBusy(false)
    if (!next) return
    jobsApi.mutate((list) => {
      const value = [next, ...(list ?? []).filter((job) => job.id !== next.id)]
      cache.value = value
      return value
    })
    setSelected(next.id)
    reset()
    void refresh()
  }

  const cancel = async (job: Job) => {
    setBusy(true)
    const next = await api.cancel(job.id).catch((error) => {
      toast.error("job did not cancel", error instanceof Error ? error.message : String(error))
      return undefined
    })
    setBusy(false)
    if (!next) return
    jobsApi.mutate((list) => {
      const value = list?.map((item) => (item.id === next.id ? next : item))
      cache.value = value
      return value
    })
    void streams(job.id)
  }

  const retry = async (job: Job) => {
    setBusy(true)
    const next = await api.retry(job.id).catch((error) => {
      toast.error("output recovery did not start", error instanceof Error ? error.message : String(error))
      return undefined
    })
    setBusy(false)
    if (!next) return
    jobsApi.mutate((list) => {
      const value = list?.map((item) => (item.id === next.id ? next : item))
      cache.value = value
      return value
    })
    void streams(job.id)
    void refresh()
  }

  const rerun = (job: Job) => {
    if (job.target.kind === "ssh") {
      toast.error(
        "remote rerun unavailable",
        "SSH dispatch stays disabled until staging, reattachment, cancellation, logs, and outputs pass real-host validation.",
      )
      return
    }
    setName(job.name)
    setCommand(job.command)
    setCwd("")
    setTarget(job.target.kind === "modal" ? "modal" : "local")
    setImage(job.modal?.image ?? "")
    setGpu(job.modal?.gpu ?? "T4")
    setUploads(job.modal?.uploads.map((file) => file.path).join(", ") ?? "")
    setPlan(undefined)
    setStamp("")
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
    await refresh(true)
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
        {/* No refresh control: this panel polls every 2.5s on its own, so the
            button only ever did what was about to happen regardless. */}
        <div style={{ display: "flex", gap: "6px" }}>
          <Show when={props.manual}>
            <Action
              title={creating() ? "Close job setup" : "New job"}
              active={creating()}
              disabled={busy()}
              onClick={() => void begin()}
            >
              <IconPlus size={16} />
            </Action>
          </Show>
        </div>
      </div>

      <Show when={jobs.error}>
        <div role="alert" style={errorBox}>
          <span style={{ flex: 1 }}>
            Compute jobs are unavailable. {jobs.error instanceof Error ? jobs.error.message : String(jobs.error)}
          </span>
          <button type="button" style={secondaryButton} onClick={() => void refresh(true)}>
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

      <Show when={props.manual && creating()}>
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
              <select
                aria-label="Run location"
                style={input}
                value={target()}
                onChange={(event) => {
                  setTarget(event.currentTarget.value as "local" | "modal")
                  setReviewed(false)
                  setPlan(undefined)
                }}
              >
                <option value="local">This computer</option>
                <option value="modal">Modal</option>
              </select>
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
          <Show when={target() === "modal"}>
            <div
              style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}
            >
              <Field label="GPU type">
                <input
                  aria-label="Modal GPU type"
                  style={input}
                  value={gpu()}
                  placeholder="none (CPU only), T4, L4, A10G, A100, H100"
                  onInput={(event) => setGpu(event.currentTarget.value)}
                />
              </Field>
              <Field label="Image override">
                <input
                  aria-label="Modal image"
                  style={input}
                  value={image()}
                  placeholder="Use the configured default"
                  onInput={(event) => setImage(event.currentTarget.value)}
                />
              </Field>
            </div>
            <Field label="Files to upload">
              <input
                aria-label="Modal upload patterns"
                style={input}
                value={uploads()}
                placeholder="train.py, src/**/*.py, data/sample.csv"
                onInput={(event) => setUploads(event.currentTarget.value)}
              />
            </Field>
            <span style={advancedHint}>
              Only matching files are uploaded. Secrets, .git, node_modules, and .openscience are denied.
            </span>
          </Show>
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
            <Show when={target() === "local"}>
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
            </Show>
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
          <Show when={approved() && command().trim()}>
            <DispatchPreview staged={staged()} />
          </Show>
          <Show when={target() === "modal" && approved() && plan()}>
            {(value) => (
              <div data-testid="modal-plan" style={captureCard}>
                <div style={cardTitle}>
                  <span>Modal approval</span>
                  <span>{bytes(value().upload_bytes)} upload</span>
                </div>
                <div style={manifestGrid}>
                  <span>App</span>
                  <strong>{value().app}</strong>
                  <span>Image</span>
                  <strong>{value().image}</strong>
                  <span>GPU</span>
                  <strong>{value().gpu}</strong>
                  <span>Network</span>
                  <strong>{value().network === "none" ? "Blocked" : "Unrestricted"}</strong>
                  <span>Timeout</span>
                  <strong>{value().timeout_minutes} min</strong>
                  <span>Inputs</span>
                  <strong>
                    {value().uploads.length
                      ? value()
                          .uploads.map((file) => file.path)
                          .join(", ")
                      : "None"}
                  </strong>
                </div>
                <span style={{ color: "var(--color-warning)", "font-size": "12px" }}>{value().warning}</span>
              </div>
            )}
          </Show>
          <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px", "padding-top": "2px" }}>
            <button type="button" style={secondaryButton} onClick={reset}>
              Cancel
            </button>
            <Show when={!approved()}>
              <button
                type="button"
                style={secondaryButton}
                disabled={!name().trim() || !command().trim()}
                onClick={() => void review()}
              >
                {target() === "modal" && busy() ? "Preparing plan…" : "Review command"}
              </button>
            </Show>
            <Show when={approved()}>
              <button
                type="submit"
                style={primaryButton}
                title={authority.message()}
                disabled={!ready() || !authority.allowed()}
              >
                {busy() ? "Dispatching…" : "Dispatch"}
              </button>
            </Show>
          </div>
        </form>
      </Show>

      <Show when={!creating() || !props.manual}>
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
                  Ask an OpenScience agent to run an experiment. Its output, captured files, and reproducibility record
                  will appear here automatically.
                </span>
                <Show when={props.manual}>
                  <button
                    type="button"
                    style={primaryButton}
                    title="Create a research job"
                    disabled={busy()}
                    onClick={() => void begin()}
                  >
                    Create first job
                  </button>
                </Show>
              </div>
            }
          >
            {/* One header over the whole ledger rather than a rule per day.
                The age is already on every row, so day bands repeated in a
                heading what the rows were saying anyway. */}
            <div style={ledgerHeader}>
              <span style={ledgerTitle}>Recent runs</span>
              <button type="button" disabled={busy()} style={clearButton} onClick={() => void clear()}>
                Clear finished
              </button>
            </div>
            <div style={list}>
              <For each={ledger(jobs() ?? [])}>
                {(item) => {
                  const job = () => item
                  return (
                    <section style={run}>
                      <button
                        type="button"
                        aria-expanded={selected() === item.id}
                        aria-controls={`compute-run-${item.id}`}
                        // A run that is still moving gets a sweep along the
                        // foot of its row. The status column already names it,
                        // but a word does not read as motion — and this is the
                        // one row in the ledger whose value will change on its
                        // own, so it is the one worth catching the eye.
                        class={terminal.has(item.status) ? undefined : "compute-run--active"}
                        onClick={() => setSelected((value) => (value === item.id ? undefined : item.id))}
                        style={{
                          ...row,
                          position: "relative",
                          background:
                            selected() === item.id
                              ? "color-mix(in srgb, var(--color-surface-solid) 92%, var(--color-accent) 8%)"
                              : "transparent",
                        }}
                      >
                        {/* Position in the ledger, not an identifier —
                                  it is what makes this read as a numbered
                                  record rather than a list of cards. */}
                        <span style={runIndex} aria-hidden="true">
                          {item.index}
                        </span>
                        <span style={runStack}>
                          <span style={runName}>{item.name}</span>
                          <span style={runTarget}>{item.target}</span>
                        </span>
                        {/* A column, so it is stated on every row: one
                                  with holes is harder to scan than one always
                                  filled, because the eye tracks a fixed
                                  position instead of hunting. */}
                        <span style={runStatus}>
                          <span style={{ ...dot, background: toneColor(item.tone) }} aria-hidden="true" />
                          <span style={{ ...runStatusText, color: toneColor(item.tone) }}>{item.statusLabel}</span>
                        </span>
                        <span style={runAge}>{age(item.created_at)}</span>
                        <span style={disclosure}>
                          <Show when={selected() === item.id} fallback={<IconChevronRight size={15} />}>
                            <IconChevronDown size={15} />
                          </Show>
                        </span>
                      </button>
                      <Show when={selected() === item.id}>
                        <div id={`compute-run-${item.id}`} style={detail}>
                          <div style={{ display: "flex", "align-items": "flex-start", gap: "12px" }}>
                            <span
                              style={{
                                color: "var(--color-text-faint)",
                                "font-family": FONT_MONO,
                                "font-size": "12px",
                                flex: 1,
                                "min-width": 0,
                              }}
                            >
                              {job().id} · {duration(job())}
                            </span>
                            <Show when={!terminal.has(job().status) && job().target.kind !== "ssh"}>
                              <Action title="Cancel job" onClick={() => void cancel(job())}>
                                <IconStop size={16} />
                              </Action>
                            </Show>
                            <Show
                              when={
                                job().target.kind === "modal" &&
                                terminal.has(job().status) &&
                                job().lifecycle?.recoverable
                              }
                            >
                              <button
                                type="button"
                                style={secondaryButton}
                                title="Retry collecting and delivering outputs from the retained Modal volume"
                                onClick={() => void retry(job())}
                              >
                                Retry delivery
                              </button>
                            </Show>
                            <Show
                              when={
                                job().target.kind === "modal" &&
                                terminal.has(job().status) &&
                                !job().lifecycle?.recoverable &&
                                job().lifecycle?.resource === "unknown"
                              }
                            >
                              <button
                                type="button"
                                style={secondaryButton}
                                title="Retry stopping the Modal sandbox and releasing its volume"
                                onClick={() => void cancel(job())}
                              >
                                Retry cleanup
                              </button>
                            </Show>
                            <Show when={props.manual}>
                              <button
                                type="button"
                                style={secondaryButton}
                                disabled={job().target.kind === "ssh"}
                                title={
                                  job().target.kind !== "ssh"
                                    ? `Rerun this command on ${job().target.kind === "modal" ? "Modal" : "this computer"}`
                                    : "Remote dispatch is unavailable until its full lifecycle passes real-host validation"
                                }
                                onClick={() => rerun(job())}
                              >
                                Rerun
                              </button>
                            </Show>
                          </div>
                          <div style={commandBox}>
                            <span style={{ color: "var(--color-text-faint)", "user-select": "none" }}>$</span>
                            <span>{job().command}</span>
                          </div>
                          <Show when={job().cwd}>
                            <div style={meta}>Working directory · {job().cwd}</div>
                          </Show>
                          <Show when={resourceLabel(job())}>
                            {(value) => <div style={meta}>Resources · {value()}</div>}
                          </Show>
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
                              <Show when={job().checkpoint}>
                                {(item) => <ArtifactRow item={item()} label="Checkpoint" />}
                              </Show>
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
                          <Show when={job().target.kind === "modal"}>
                            <div data-testid="modal-logs" style={logHeader}>
                              <span>Logs</span>
                              <span style={{ display: "inline-flex", "align-items": "center", gap: "8px" }}>
                                <span>{events()?.length ?? 0} bytes</span>
                                <button
                                  type="button"
                                  title="Download Modal logs"
                                  aria-label="Download Modal logs"
                                  style={iconButton}
                                  onClick={() => save(`${safeName(job().name)}-modal.log`, events() ?? "")}
                                >
                                  <IconDownload size={14} />
                                </button>
                              </span>
                            </div>
                            <pre style={log} aria-busy={eventsBusy()}>
                              {events() ||
                                (terminal.has(job().status)
                                  ? "No Modal lifecycle logs were captured."
                                  : "Waiting for Modal…")}
                            </pre>
                          </Show>
                          <div style={logHeader}>
                            <span>Output</span>
                            <span style={{ display: "inline-flex", "align-items": "center", gap: "8px" }}>
                              <span>{output()?.length ?? 0} bytes</span>
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
                          <pre style={log} aria-busy={outputBusy()}>
                            {output() ||
                              (job().status === "cancelled"
                                ? "Run cancelled."
                                : terminal.has(job().status)
                                  ? "No output was captured."
                                  : "Waiting for output…")}
                          </pre>
                          <Show when={job().error}>
                            <div style={errorBox}>{job().error}</div>
                          </Show>
                          <Show when={job().cleanup_error}>
                            <div style={errorBox}>{job().cleanup_error}</div>
                          </Show>
                          <Show when={job().capture_error}>
                            <div style={errorBox}>
                              The run finished, but reproducibility capture failed: {job().capture_error}
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </section>
                  )
                }}
              </For>
            </div>
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
            "font-size": "14px",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
          title={props.item.path}
        >
          {props.item.path}
        </strong>
        <span style={{ color: "var(--color-text-faint)", "font-family": FONT_MONO, "font-size": "12px" }}>
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
  "font-size": "14px",
  "font-weight": 600,
  "letter-spacing": "-0.01em",
  "line-height": 1.2,
}

const subtitle: JSX.CSSProperties = {
  color: "var(--color-text-faint)",
  "font-family": FONT_SANS,
  "font-size": "12px",
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
  "font-size": "14px",
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
  "font-size": "14px",
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
  "font-size": "14px",
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
  "font-size": "12px",
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
  "font-size": "14px",
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
  "font-size": "14px",
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
  "font-size": "14px",
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
  "font-size": "14px",
  "font-weight": 600,
  "letter-spacing": "-0.01em",
}

const emptyCopy: JSX.CSSProperties = {
  "max-width": "360px",
  color: "var(--color-text-muted)",
  "font-size": "14px",
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
  "font-size": "12px",
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
  flex: 1,
  "min-height": 0,
  display: "flex",
  "flex-direction": "column",
  gap: 0,
  padding: "0 8px 8px",
  overflow: "auto",
}

const run: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
}

// 3a's ledger: a numbered record, not a stack of cards. The day rules are
// gone — the age is already on every row, so the bands repeated in a heading
// what the rows were saying anyway.
const ledgerHeader: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "12px",
  padding: "6px 18px 8px",
  "border-bottom": "1px solid var(--color-border)",
  "flex-shrink": 0,
}

const ledgerTitle: JSX.CSSProperties = {
  color: "var(--color-text-faint)",
  "font-size": "10px",
}

const clearButton: JSX.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  color: "var(--icon-brand-base)",
  "font-family": FONT_SANS,
  "font-size": "12px",
}

const runIndex: JSX.CSSProperties = {
  width: "16px",
  flex: "none",
  color: "var(--color-text-faint)",
  "font-size": "10px",
  "font-variant-numeric": "tabular-nums",
}

const runStack: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "2px",
  "min-width": 0,
  flex: 1,
}

const runName: JSX.CSSProperties = {
  color: "var(--color-text)",
  "font-size": "14px",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
}

// Where it ran, on its own line under the name rather than competing with it.
const runTarget: JSX.CSSProperties = {
  color: "var(--color-text-muted)",
  "font-size": "10px",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "white-space": "nowrap",
}

const runStatus: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "6px",
  flex: "none",
}

const runStatusText: JSX.CSSProperties = {
  width: "66px",
  "font-size": "10px",
  "white-space": "nowrap",
}

const dot: JSX.CSSProperties = {
  width: "5px",
  height: "5px",
  "border-radius": "50%",
  flex: "none",
}

const runAge: JSX.CSSProperties = {
  width: "22px",
  flex: "none",
  "text-align": "right",
  color: "var(--color-text-faint)",
  "font-size": "10px",
  "font-variant-numeric": "tabular-nums",
  "white-space": "nowrap",
}

// Status reaches the dot and the word through the same semantic tokens the
// rest of the app uses; the app ships 16 themes and a literal colour here
// would be right in exactly one of them.
function toneColor(tone: RunTone): string {
  if (tone === "danger") return "var(--color-error)"
  if (tone === "success") return "var(--color-success)"
  if (tone === "active") return "var(--color-warning)"
  return "var(--color-text-muted)"
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

const disclosure: JSX.CSSProperties = {
  width: "20px",
  height: "20px",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  color: "var(--color-text-faint)",
  "flex-shrink": 0,
}

const detail: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "10px",
  padding: "8px 8px 16px 32px",
  background: "color-mix(in srgb, var(--color-bg-subtle) 36%, transparent)",
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
  "font-size": "12px",
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
  "font-size": "12px",
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
  "font-size": "12px",
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
  "font-size": "12px",
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
  "min-height": "120px",
  "max-height": "280px",
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
