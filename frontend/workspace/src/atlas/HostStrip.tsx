import { Show, createMemo, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { hostReading, type Capacity } from "@/atlas/host-instruments"
import { identify } from "@/atlas/poll-identity"
import { createKernelRouteRequester, kernelAPI } from "@/atlas/kernel-api"
import "@/atlas/HostStrip.css"

type HostStripProps = {
  request?: (path: string) => Promise<Response>
}

export function HostStrip(props: HostStripProps = {}): JSX.Element {
  const request = props.request ?? useSDK().request
  const kernelRequest = createKernelRouteRequester(request)
  const client = identify()
  const [health, setHealth] = createSignal<"loading" | "available" | "unavailable">("loading")
  const load = () =>
    kernelRequest(kernelAPI.compute(client))
      .then((response) => (response.ok ? (response.json() as Promise<Capacity>) : undefined))
      .then((capacity) => {
        setHealth(capacity ? "available" : "unavailable")
        return capacity
      })
      .catch(() => {
        setHealth("unavailable")
        return undefined
      })
  const [data, api] = createResource(load)
  const reading = createMemo(() => hostReading(data.latest))
  const processDetail = () => {
    const detail = reading().kernels
    if (detail === "kernel count unavailable" || /^\d/.test(detail)) return detail
    return `${reading().live} ${detail}`
  }
  const refresh = () => {
    if (document.hidden || data.loading) return
    void api.refetch()
  }
  const timer = setInterval(refresh, 2_500)
  document.addEventListener("visibilitychange", refresh)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", refresh)
  })

  return (
    <details class="activity-surface__capacity" data-health={health()}>
      <summary>
        <span class="activity-surface__capacity-title">
          <strong>
            <span class="activity-surface__capacity-title-prefix">Local </span>capacity
          </strong>
          <small>
            {health() === "loading" ? "Reading resources…" : health() === "available" ? "Live" : "Unavailable"}
          </small>
        </span>
        <Show
          when={health() === "available"}
          fallback={
            <span class="activity-surface__capacity-state">
              {health() === "loading" ? "Checking…" : "Could not read"}
            </span>
          }
        >
          <span class="activity-surface__capacity-reading" aria-label="Current local capacity">
            <span>
              <small>Memory</small>
              <strong>{reading().headline}</strong>
            </span>
            <span>
              <small>CPU</small>
              <strong>{reading().cores.replace(" of ", "/")}</strong>
            </span>
            <span>
              <small>Running</small>
              <strong>{reading().running}</strong>
            </span>
          </span>
        </Show>
      </summary>
      <section class="host-strip" aria-label="Machine resources" data-testid="host-strip">
        <div class="host-strip__metric" data-host-tile="memory">
          <span class="host-strip__label">Memory</span>
          <p>
            <strong class="host-strip__headline">{reading().headline}</strong>
            <span>{reading().memory.replace(/ memory$/, "")}</span>
          </p>
          <Meter value={reading().memoryFill} />
        </div>

        <div class="host-strip__metric" data-host-tile="cpu">
          <span class="host-strip__label">CPU</span>
          <p>
            <strong class="host-strip__cores-value">{reading().cores}</strong>
            <span>cores</span>
          </p>
          <Meter value={reading().cpuFill} />
        </div>

        <div class="host-strip__metric host-strip__metric--kernels" data-host-tile="kernels">
          <span class="host-strip__label">Running</span>
          <p
            title={processDetail()}
            aria-label={`${reading().running} running ${reading().running === "1" ? "process" : "processes"}. ${processDetail()}`}
          >
            <strong class="host-strip__kernels-value">{reading().running}</strong>
            <span>{reading().running === "1" ? "process" : "processes"}</span>
          </p>
        </div>
      </section>
    </details>
  )
}

function Meter(props: { value: number }): JSX.Element {
  return (
    <span class="host-strip__meter" role="presentation" aria-hidden="true">
      <i style={{ width: `${Math.round(props.value * 100)}%` }} />
    </span>
  )
}
