import { For, Show, createEffect, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { IconCpu, IconPlus, IconRefresh } from "@/atlas/shared/Icon"
import { summarizeKernels, type KernelStatus } from "@/notebook/runtime"
import { useExecutionAuthority } from "./use-execution-authority"
import { KernelCard, type KernelAction } from "./KernelCard"

type Response = { kernels: KernelStatus[] }
type ControlResponse = KernelStatus & { state_preserved?: boolean }

const time = (value: number | null) => {
  if (!value) return "Unavailable"
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

export function KernelPanel(props: { onEnsureSession?: () => Promise<string | undefined> } = {}): JSX.Element {
  const sdk = useSDK()
  const params = useParams()
  const authority = useExecutionAuthority("kernel")
  const [view, setView] = createStore<{
    error: string
    problem: string
    notice: string
    updated: number
    action: string
    creating: boolean
    name: string
    language: "python" | "r"
  }>({
    error: "",
    problem: "",
    notice: "",
    updated: 0,
    action: "",
    creating: false,
    name: "",
    language: "python",
  })
  const request = async <T,>(path: string, init?: RequestInit, query?: Record<string, string>) => {
    const response = await sdk.request(path, init, query)
    if (response.ok) return response.json() as Promise<T>
    const detail = await response.text().catch(() => "")
    throw new Error(detail || `${response.status} ${response.statusText}`)
  }
  const load = () => {
    if (!params.id || params.id === "new") return Promise.resolve({ kernels: [] })
    return request<Response>("/notebook/kernels", undefined, { sessionID: params.id }).then(
      (value) => {
        setView({ error: "", updated: Date.now() })
        return value
      },
      (error) => {
        setView("error", error instanceof Error ? error.message : String(error))
        throw error
      },
    )
  }
  const [data, api] = createResource(load)
  const kernels = () => data()?.kernels ?? []
  const summary = createMemo(() => summarizeKernels(kernels()))
  const ensureSession = async () => {
    if (params.id && params.id !== "new") return params.id
    return props.onEnsureSession?.()
  }
  const begin = async () => {
    if (view.creating) {
      setView("creating", false)
      return
    }
    const id = await ensureSession()
    if (!id) {
      setView("problem", "OpenScience could not create a session for this kernel.")
      return
    }
    setView({ creating: true, problem: "" })
  }
  const create = async () => {
    if (!view.name.trim() || view.action) return
    const sessionID = await ensureSession()
    if (!sessionID) {
      setView("problem", "OpenScience could not create a session for this kernel.")
      return
    }
    setView({ action: "create", problem: "", notice: "" })
    return request<KernelStatus>("/notebook/kernels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID,
        name: view.name.trim(),
        language: view.language,
      }),
    })
      .then(() => {
        setView({
          creating: false,
          name: "",
          language: "python",
          notice: "Named kernel created. Start it when you need a separate in-memory environment.",
        })
        return api.refetch()
      })
      .catch((error) => setView("problem", error instanceof Error ? error.message : String(error)))
      .finally(() => setView("action", ""))
  }
  const control = (kernel: KernelStatus, action: KernelAction) => {
    if (action === "restart" && !authority.allowed()) {
      setView("problem", authority.message() ?? "This session cannot start a kernel.")
      return
    }
    const key = `${kernel.id}:${action}`
    setView({ action: key, problem: "", notice: "" })
    const remove = action === "delete"
    return request<ControlResponse>(
      remove
        ? `/notebook/kernels/${encodeURIComponent(kernel.id)}`
        : `/notebook/kernels/${encodeURIComponent(kernel.id)}/${action}`,
      {
        method: remove ? "DELETE" : "POST",
        ...(remove
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionID: kernel.sessionID }),
            }),
      },
      remove ? { sessionID: kernel.sessionID } : undefined,
    )
      .then((value) => {
        const notice =
          action === "restart"
            ? "Kernel restarted in a fresh runtime. Previous in-memory variables and queued work were cleared."
            : action === "stop"
              ? "Kernel stopped. In-memory state was cleared. Run a cell to start fresh."
              : action === "delete"
                ? "Inactive kernel record forgotten."
                : value.state_preserved
                  ? "Execution interrupted. Runtime state was preserved."
                  : "Execution stopped and runtime state was cleared. Run a cell to start fresh."
        setView("notice", notice)
        return api.refetch()
      })
      .catch((error) => setView("problem", error instanceof Error ? error.message : String(error)))
      .finally(() => setView("action", ""))
  }
  createEffect(() => {
    if (summary().running === 0 && summary().queued === 0) return
    const timer = setInterval(() => void api.refetch(), 2_500)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <section aria-label="Session kernel control room" data-testid="kernel-panel" class="kernel-panel">
      <header class="kernel-panel__header">
        <div class="kernel-panel__heading">
          <span class="kernel-panel__eyebrow">Compute</span>
          <strong>Session kernels</strong>
          <span>
            {summary().live} live · {summary().running} running · {summary().queued} queued
          </span>
        </div>
        <div class="kernel-panel__refresh">
          <Show when={view.updated}>
            <span aria-label={`Updated ${time(view.updated)}`}>{time(view.updated)}</span>
          </Show>
          <button
            type="button"
            aria-label="Create named kernel"
            title="Create an isolated named Python or R kernel"
            onClick={() => void begin()}
            disabled={!!view.action}
          >
            <IconPlus size={13} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            aria-label="Refresh kernels"
            title="Refresh kernel inventory"
            onClick={() => void api.refetch()}
            disabled={data.loading}
          >
            <IconRefresh size={12} strokeWidth={1.6} />
          </button>
        </div>
      </header>

      <div class="atlas-scroll kernel-panel__body">
        <Show when={view.creating}>
          <form
            class="kernel-panel__create"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <label>
              <span>Kernel name</span>
              <input
                aria-label="Kernel name"
                value={view.name}
                maxlength={120}
                placeholder="analysis"
                autofocus
                onInput={(event) => setView("name", event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Language</span>
              <select
                aria-label="Kernel language"
                value={view.language}
                onChange={(event) => setView("language", event.currentTarget.value as "python" | "r")}
              >
                <option value="python">Python</option>
                <option value="r">R</option>
              </select>
            </label>
            <div>
              <button type="button" onClick={() => setView({ creating: false, name: "" })}>
                Cancel
              </button>
              <button type="submit" disabled={!view.name.trim() || !!view.action}>
                {view.action === "create" ? "Creating…" : "Create kernel"}
              </button>
            </div>
          </form>
        </Show>

        <section class="kernel-panel__scope" aria-label="Kernel ownership model">
          <span class="kernel-panel__scope-icon" aria-hidden="true">
            <IconCpu size={13} strokeWidth={1.5} />
          </span>
          <p>
            <strong>Session-owned kernels.</strong> Named records survive app restarts; live variables persist only
            while their backend process remains alive.
          </p>
        </section>

        <Show when={authority.message()}>
          {(message) => (
            <div
              role={authority.decision.error ? "alert" : "status"}
              class="kernel-panel__message kernel-panel__message--authority"
            >
              {message()}
            </div>
          )}
        </Show>

        <Show when={view.error || view.problem}>
          <div role="alert" class="kernel-panel__message kernel-panel__message--error">
            {view.problem ? `Kernel control failed. ${view.problem}` : `Kernel inventory unavailable. ${view.error}`}
          </div>
        </Show>
        <Show when={view.notice}>
          <div role="status" class="kernel-panel__message">
            {view.notice}
          </div>
        </Show>

        <Show
          when={kernels().length > 0}
          fallback={
            <div class="kernel-panel__empty">
              <span aria-hidden="true">
                <IconCpu size={15} strokeWidth={1.4} />
              </span>
              <strong>No active kernels</strong>
              <p>A real session exposes its default Python record here before starting a process.</p>
            </div>
          }
        >
          <div class="kernel-panel__list">
            <For each={kernels()}>
              {(kernel) => (
                <KernelCard
                  kernel={kernel}
                  routeID={params.id}
                  action={view.action}
                  restartDisabled={!authority.allowed()}
                  restartTitle={authority.message()}
                  onControl={(action) => void control(kernel, action)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </section>
  )
}
