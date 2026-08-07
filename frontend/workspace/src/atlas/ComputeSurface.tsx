import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type Component,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { ComputeJobs } from "@/atlas/ComputeJobs"
import { createComputeJobsAPI, type Status } from "@/atlas/ComputeJobsAPI"
import { HostStrip } from "@/atlas/HostStrip"
import type { Capacity } from "@/atlas/host-instruments"
import { KernelPanel } from "@/atlas/KernelPanel"
import { useSDK } from "@/context/sdk"
import type { ProjectRequest } from "@/utils/openscience-fetch"
import "@/atlas/ComputeSurface.css"

type Tab = "kernels" | "jobs"

type ComputeSurfaceProps = {
  strip?: Component
  kernels?: Component<{
    onEnsureSession?: () => Promise<string | undefined>
    capacity?: Partial<Capacity>
  }>
  jobs?: Component<{
    onEnsureSession?: () => Promise<string | undefined>
    onActiveChange?: (count: number) => void
    onTotalChange?: (count: number) => void
    manual?: boolean
  }>
  onEnsureSession?: () => Promise<string | undefined>
  request?: ProjectRequest
}

const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])
const inactiveRefresh = 15_000

const tabs = [
  { id: "kernels", label: "Kernels" },
  { id: "jobs", label: "Jobs" },
] as const

export function ComputeSurface(props: ComputeSurfaceProps = {}): JSX.Element {
  // `active` still drives nothing visible on its own — the counts beside each
  // tab label are totals, which is what 5a shows and what a glance wants:
  // "how much is here", not "how much is moving". The active figure stays
  // because the jobs panel reports it and the empty/idle copy reads better
  // knowing it.
  const [state, setState] = createStore({ tab: "kernels" as Tab, active: 0, jobs: 0, kernels: 0 })
  const id = createUniqueId()
  const refs: Partial<Record<Tab, HTMLButtonElement>> = {}
  const strip = props.strip ?? HostStrip
  const kernels = props.kernels ?? KernelPanel
  const jobs = props.jobs ?? ComputeJobs
  const api = createComputeJobsAPI(props.request ?? useSDK().request)
  const [capacity, setCapacity] = createSignal<Capacity | undefined>()

  const refresh = async () => {
    const list = await api.list().catch(() => undefined)
    if (!list) return
    setState("active", list.filter((job) => !terminal.has(job.status)).length)
    setState("jobs", list.length)
  }

  // Only while the jobs panel is not mounted: when it is, it reports its own
  // total off the poll it already runs, and a second poll here would ask the
  // same route twice as often for the same number.
  createEffect(() => {
    if (state.tab !== "jobs") void refresh()
  })

  const timer = setInterval(() => {
    if (state.tab !== "jobs") void refresh()
  }, inactiveRefresh)
  onCleanup(() => clearInterval(timer))

  const select = (next: Tab, focus = false) => {
    setState("tab", next)
    if (focus) queueMicrotask(() => refs[next]?.focus())
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    const current = tabs.findIndex((item) => item.id === state.tab)
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? (current + 1) % tabs.length
            : (current <= 0 ? tabs.length : current) - 1
    const next = tabs[index]
    if (!next) return
    event.preventDefault()
    select(next.id, true)
  }

  return (
    <section class="compute-surface" aria-label="Compute">
      <Dynamic component={strip} onKernels={(live: number) => setState("kernels", live)} onCapacity={setCapacity} />
      <div
        class="compute-surface__tabs"
        role="tablist"
        aria-label="Compute views"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
      >
        <For each={tabs}>
          {(item) => (
            <button
              ref={(element) => (refs[item.id] = element)}
              id={`${id}-${item.id}-tab`}
              type="button"
              role="tab"
              class="compute-surface__tab"
              data-compute-tab={item.id}
              data-active={state.tab === item.id}
              aria-selected={state.tab === item.id}
              aria-controls={`${id}-${item.id}-panel`}
              tabindex={state.tab === item.id ? 0 : -1}
              onClick={() => select(item.id)}
            >
              <span>{item.label}</span>
              {/* The count rides in the label rather than in a badge: 5a puts
                  the two numbers on the same baseline as their words so the
                  row reads as one line of type, and drops the badge that
                  competed with the terracotta underline for the eye. */}
              <span class="compute-surface__count" aria-hidden="true">
                {item.id === "jobs" ? state.jobs : state.kernels}
              </span>
              <span class="compute-surface__sr">
                {item.id === "jobs"
                  ? `${state.jobs} job${state.jobs === 1 ? "" : "s"}`
                  : `${state.kernels} kernel${state.kernels === 1 ? "" : "s"}`}
              </span>
            </button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={state.tab === "kernels"}>
          <div
            id={`${id}-kernels-panel`}
            class="compute-surface__panel"
            role="tabpanel"
            aria-labelledby={`${id}-kernels-tab`}
            tabindex={0}
          >
            <Dynamic component={kernels} onEnsureSession={props.onEnsureSession} capacity={capacity()} />
          </div>
        </Match>
        <Match when={state.tab === "jobs"}>
          <div
            id={`${id}-jobs-panel`}
            class="compute-surface__panel"
            role="tabpanel"
            aria-labelledby={`${id}-jobs-tab`}
            tabindex={0}
          >
            <Dynamic
              component={jobs}
              onEnsureSession={props.onEnsureSession}
              onActiveChange={(count) => setState("active", count)}
              onTotalChange={(count) => setState("jobs", count)}
              manual={false}
            />
          </div>
        </Match>
      </Switch>
    </section>
  )
}
