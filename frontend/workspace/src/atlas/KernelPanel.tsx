import { For, Show, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { IconCpu } from "@/atlas/shared/Icon"
import { kernelLabel, kernelLanguageLabel, type KernelStatus } from "@/notebook/runtime"
import { useExecutionAuthority } from "./use-execution-authority"
import { useKernelList } from "./use-kernel-list"
import { identify } from "@/atlas/poll-identity"
import type { Capacity } from "./host-instruments"
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
  // Measured once by the host strip above and passed down, so every plate's
  // ceiling agrees with the headline figure the user is reading beside it.
  capacity?: Partial<Capacity>
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
  const sync = useSync()
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
    if (response.ok) {
      const body = await response.text()
      if (!body) return undefined as T
      return JSON.parse(body) as T
    }
    const detail = await response.text().catch(() => "")
    throw new Error(detail || `${response.status} ${response.statusText}`)
  }
  const load = () => {
    return inventory(request<KernelsPayload>("/notebook/kernels", undefined, { client }), (error) =>
      setView(error ? { error } : { error: "", updated: Date.now() }),
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
  // HostStrip.tsx for the full mechanism).
  const kernels = useKernelList(() => data.latest?.kernels)
  const route = () => (params.id && params.id !== "new" ? params.id : undefined)
  const live = createMemo(() => kernels.filter((kernel) => kernel.active || kernel.state === "starting"))
  const saved = createMemo(() =>
    kernels.filter(
      (kernel) =>
        !kernel.active &&
        kernel.state !== "starting" &&
        kernel.name !== "agent" &&
        !kernel.name.startsWith("notebook:"),
    ),
  )
  const title = (sessionID: string) => sync.session.get(sessionID)?.title?.trim() || "Untitled session"
  const grouped = createMemo(() => {
    const grouped = new Map<string, KernelStatus[]>()
    for (const kernel of live()) grouped.set(kernel.sessionID, [...(grouped.get(kernel.sessionID) ?? []), kernel])
    return grouped
  })
  const groups = createMemo(() =>
    [...grouped().keys()].sort((a, b) => {
      const current = Number(route() === b) - Number(route() === a)
      if (current) return current
      const activity = (sessionID: string) =>
        Math.max(...(grouped().get(sessionID) ?? []).map((kernel) => kernel.last_activity_at ?? kernel.started_at ?? 0))
      return activity(b) - activity(a)
    }),
  )
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
    if (action === "restart") {
      if (kernel.sessionID !== route()) {
        setView("problem", "Open the owning session before starting or restarting this kernel.")
        return
      }
      if (!authority.allowed()) {
        setView("problem", authority.message() ?? "This session cannot start a kernel.")
        return
      }
    }
    const key = `${kernel.id}:${action}`
    const starting = action === "restart" && !kernel.active
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
            ? starting
              ? "Kernel started in a fresh runtime."
              : "Kernel restarted in a fresh runtime. Previous in-memory variables and queued work were cleared."
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
    <section aria-label="Project kernel control room" data-testid="kernel-panel" class="kernel-panel">
      <header class="kernel-panel__header">
        <div class="kernel-panel__heading">
          {/* No "Compute" eyebrow: the tab above already says it, and 5a's
              restraint is mostly about not saying things twice. The live/
              running/queued breakdown moved onto the kernel's own metric grid,
              where it sits beside the figures it qualifies. */}
          <strong>Project kernels</strong>
          <span>{view.updated ? `Synced ${time(view.updated)}` : "Not synced yet"}</span>
        </div>
        {/* No refresh control: the panel already polls every 2.5s and on
            visibilitychange, so the button asked the user to do what was
            happening anyway — and disabling it per poll made it flicker
            twice a second. The "Synced Ns ago" line beside the title is the
            honest version of the same information. */}
        <div class="kernel-panel__refresh">
          <button
            type="button"
            class="kernel-panel__primary-action"
            aria-label="Create named kernel"
            title="Create an isolated named Python or R kernel"
            onClick={() => void begin()}
            disabled={!!view.action}
          >
            New kernel
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

        {/* Prose, not a callout. The icon and the bolded lead-in made this read
            as a warning about something that is simply how kernels work. */}
        <section class="kernel-panel__scope" aria-label="Kernel ownership model">
          <p>
            Only process-backed runtimes count as kernels. Named environments survive app restarts; live variables do
            not.
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
          when={groups().length > 0}
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
                  ? "The last poll could not read this project's kernels, so this is not a count of what is running."
                  : "Kernels appear here when any session in this project starts a runtime."}
              </p>
            </div>
          }
        >
          <div class="kernel-panel__sessions">
            <For each={groups()}>
              {(sessionID) => (
                <section class="kernel-session" data-current={route() === sessionID ? "true" : undefined}>
                  <header class="kernel-session__header">
                    <div>
                      <strong>{title(sessionID)}</strong>
                      <span>{route() === sessionID ? "Current session" : "Project session"}</span>
                    </div>
                    <span>
                      {grouped().get(sessionID)?.length ?? 0}{" "}
                      {grouped().get(sessionID)?.length === 1 ? "kernel" : "kernels"}
                    </span>
                  </header>
                  <div class="kernel-panel__list">
                    <For each={grouped().get(sessionID) ?? []}>
                      {(kernel, index) => (
                        <KernelCard
                          kernel={kernel}
                          index={index()}
                          capacity={props.capacity}
                          routeID={route()}
                          action={view.action}
                          restartDisabled={kernel.sessionID !== route() || !authority.allowed()}
                          restartTitle={
                            kernel.sessionID !== route()
                              ? "Open the owning session to restart this kernel."
                              : authority.message()
                          }
                          onControl={(action) => void control(kernel, action)}
                        />
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>

        <Show when={saved().length > 0}>
          <section class="kernel-panel__saved" aria-label="Saved kernel environments">
            <header>
              <strong>Saved environments</strong>
              <span>{saved().length}</span>
            </header>
            <For each={saved()}>
              {(kernel) => (
                <div class="kernel-panel__saved-row">
                  <div>
                    <strong>{kernelLabel(kernel)}</strong>
                    <span>
                      {title(kernel.sessionID)} · {kernelLanguageLabel(kernel)} · not running
                    </span>
                  </div>
                  <div>
                    <button
                      type="button"
                      disabled={!!view.action || kernel.sessionID !== route() || !authority.allowed()}
                      title={
                        kernel.sessionID !== route() ? "Open the owning session to start this environment." : undefined
                      }
                      onClick={() => void control(kernel, "restart")}
                    >
                      {view.action === `${kernel.id}:restart` ? "Starting…" : "Start"}
                    </button>
                    <button type="button" disabled={!!view.action} onClick={() => void control(kernel, "delete")}>
                      {view.action === `${kernel.id}:delete` ? "Forgetting…" : "Forget"}
                    </button>
                  </div>
                </div>
              )}
            </For>
          </section>
        </Show>
      </div>
    </section>
  )
}
