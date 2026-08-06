import { For, Show, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { IconCpu, IconPlus, IconRefresh } from "@/atlas/shared/Icon"
import { summarizeKernels, type KernelStatus } from "@/notebook/runtime"
import { useExecutionAuthority } from "./use-execution-authority"
import { useKernelList } from "./use-kernel-list"
import { identify } from "@/atlas/poll-identity"
import { KernelCard, type KernelAction } from "./KernelCard"

type KernelsPayload = { kernels: KernelStatus[] }
type ControlResponse = KernelStatus & { state_preserved?: boolean }

const time = (value: number | null) => {
  if (!value) return "Unavailable"
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

type KernelPanelProps = {
  onEnsureSession?: () => Promise<string | undefined>
  // The transport is a prop so a poll-behavior test can mount the real
  // component against a controlled response instead of a live SDK; the
  // session SDK supplies it in the product. See HostStrip.tsx for the same
  // seam.
  request?: (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>
}

// A poll that fails resolves to no inventory instead of rejecting. An errored
// resource re-throws wherever it is read — `data.latest` below — and the
// nearest ErrorBoundary wraps the entire workspace (app.tsx), so a server
// restart, a sleep/wake, or one 503 would swap the whole app for the error
// page every 2.5s in every session. HostStrip's fetcher already degrades this
// way; this is the same rule for the panel that sits beneath it.
//
// Exported rather than inlined because the panel itself cannot be mounted in a
// test: useExecutionAuthority calls useSDK() unconditionally and useParams()
// needs a Router, so this is the seam where the degraded path is reachable.
export function inventory<T>(request: Promise<T>, settled: (error: string) => void) {
  return request.then(
    (value) => {
      settled("")
      return value
    },
    (error) => {
      settled(error instanceof Error ? error.message : String(error))
      return undefined
    },
  )
}

export function KernelPanel(props: KernelPanelProps = {}): JSX.Element {
  const transport = props.request ?? useSDK().request
  // Per-kernel CPU is measured across the window since this caller's previous
  // poll, so a panel that does not name itself shares one window with every
  // other panel on the route — two tabs then truncate each other's window to
  // the stagger between them and both read Unavailable forever.
  const client = identify()
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
    const response = await transport(path, init, query)
    if (response.ok) return response.json() as Promise<T>
    const detail = await response.text().catch(() => "")
    throw new Error(detail || `${response.status} ${response.statusText}`)
  }
  const load = () => {
    if (!params.id || params.id === "new") return Promise.resolve({ kernels: [] })
    return inventory(
      request<KernelsPayload>("/notebook/kernels", undefined, { sessionID: params.id, client }),
      (error) => setView(error ? { error } : { error: "", updated: Date.now() }),
    )
  }
  const [data, api] = createResource(load)
  // The rendered list is the resource's kernels reconciled into a store keyed
  // by id (see use-kernel-list.ts), not the resource read directly — that
  // keeps unchanged kernel cards mounted across a poll instead of being torn
  // down and recreated every 2.5s.
  //
  // Read `data.latest` rather than `data()`: `data()` re-registers with the
  // nearest Suspense boundary on every in-flight fetch, which suspends the
  // entire RightPane on every 2.5s poll. `.latest` only suspends on the first
  // load and returns the previous value while a refetch is in flight (see
  // HostStrip.tsx for the full mechanism). `data.loading`, used below to
  // disable the refresh button, is unaffected and left alone.
  const kernels = useKernelList(() => data.latest?.kernels)
  const summary = createMemo(() => summarizeKernels(kernels))
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
  // Polls unconditionally while the panel is mounted — not just while a
  // kernel is already running or queued. Gating on summary() created a
  // chicken-and-egg: a fresh session starts at {live: 0, running: 0, queued:
  // 0}, so the poll that would ever discover a kernel starting never began.
  // See HostStrip.tsx for the identical shape: a hidden tab skips its polls,
  // and returning to it refreshes immediately rather than waiting out the
  // interval.
  const refresh = () => {
    if (document.hidden) return
    void api.refetch()
  }
  const timer = setInterval(refresh, 2_500)
  document.addEventListener("visibilitychange", refresh)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", refresh)
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
          when={kernels.length > 0}
          fallback={
            <div class="kernel-panel__empty">
              <span aria-hidden="true">
                <IconCpu size={15} strokeWidth={1.4} />
              </span>
              {/* A failed poll leaves nothing to list, and "No live kernels"
                  would then state as fact something this panel does not know.
                  The alert above carries the detail; this says what the empty
                  list means. */}
              <strong>{view.error ? "Kernel inventory unavailable" : "No live kernels"}</strong>
              <p>
                {view.error
                  ? "The last poll could not read this session's kernels, so this is not a count of what is running."
                  : "Kernels appear here the moment this session starts computing."}
              </p>
            </div>
          }
        >
          <div class="kernel-panel__list">
            <For each={kernels}>
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
