import { createMemo, createResource, createSignal, onCleanup, type JSX } from "solid-js"
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
  const kernelCount = () => data.latest?.kernels.live
  const runningCount = () => data.latest?.kernels.running
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
    <section class="host-strip" aria-label="Current local compute" data-testid="host-strip" data-health={health()}>
      <div class="host-strip__metric" data-host-tile="memory">
        <span class="host-strip__label">Memory</span>
        <p>
          <strong class="host-strip__headline">{reading().headline}</strong>
          <span class="host-strip__total">{reading().memory}</span>
        </p>
        <Meter value={reading().memoryFill} />
      </div>

      <div class="host-strip__metric" data-host-tile="cpu">
        <span class="host-strip__label">CPU</span>
        <p>
          <strong class="host-strip__cores-value">{reading().cores}</strong>
          <span class="host-strip__total">cores</span>
        </p>
        <Meter value={reading().cpuFill} />
      </div>

      <div class="host-strip__metric host-strip__metric--kernels" data-host-tile="kernels">
        <span class="host-strip__label">Kernels</span>
        <p aria-label={`${kernelCount() ?? "Unknown"} kernels, ${runningCount() ?? "unknown"} running`}>
          <strong class="host-strip__kernels-value">{kernelCount() ?? "—"}</strong>
        </p>
        <span class="host-strip__kernel-state">
          {kernelCount() === 1 ? "kernel" : "kernels"} · {runningCount() ?? "—"} running
        </span>
      </div>
      <span class="host-strip__health" aria-live="polite">
        {health() === "loading" ? "Reading usage…" : health() === "unavailable" ? "Usage unavailable" : ""}
      </span>
    </section>
  )
}

function Meter(props: { value: number }): JSX.Element {
  return (
    <span class="host-strip__meter" role="presentation" aria-hidden="true">
      <i style={{ width: `${Math.round(props.value * 100)}%` }} />
    </span>
  )
}
