import { createSignal, createUniqueId, For, Match, Switch, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ComputeJobs } from "@/atlas/ComputeJobs"
import { HostStrip } from "@/atlas/HostStrip"
import { KernelPanel } from "@/atlas/KernelPanel"
import "@/atlas/ComputeSurface.css"

type Tab = "kernels" | "jobs"

type ComputeSurfaceProps = {
  strip?: Component
  kernels?: Component<{ onEnsureSession?: () => Promise<string | undefined> }>
  jobs?: Component<{ onEnsureSession?: () => Promise<string | undefined> }>
  onEnsureSession?: () => Promise<string | undefined>
}

const tabs = [
  { id: "kernels", label: "Kernels" },
  { id: "jobs", label: "Jobs" },
] as const

export function ComputeSurface(props: ComputeSurfaceProps = {}): JSX.Element {
  const [tab, setTab] = createSignal<Tab>("kernels")
  const id = createUniqueId()
  const refs: Partial<Record<Tab, HTMLButtonElement>> = {}
  const strip = props.strip ?? HostStrip
  const kernels = props.kernels ?? KernelPanel
  const jobs = props.jobs ?? ComputeJobs

  const select = (next: Tab, focus = false) => {
    setTab(next)
    if (focus) queueMicrotask(() => refs[next]?.focus())
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    const current = tabs.findIndex((item) => item.id === tab())
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
      <Dynamic component={strip} />
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
              data-active={tab() === item.id}
              aria-selected={tab() === item.id}
              aria-controls={`${id}-${item.id}-panel`}
              tabindex={tab() === item.id ? 0 : -1}
              onClick={() => select(item.id)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={tab() === "kernels"}>
          <div
            id={`${id}-kernels-panel`}
            class="compute-surface__panel"
            role="tabpanel"
            aria-labelledby={`${id}-kernels-tab`}
            tabindex={0}
          >
            <Dynamic component={kernels} onEnsureSession={props.onEnsureSession} />
          </div>
        </Match>
        <Match when={tab() === "jobs"}>
          <div
            id={`${id}-jobs-panel`}
            class="compute-surface__panel"
            role="tabpanel"
            aria-labelledby={`${id}-jobs-tab`}
            tabindex={0}
          >
            <Dynamic component={jobs} onEnsureSession={props.onEnsureSession} />
          </div>
        </Match>
      </Switch>
    </section>
  )
}
