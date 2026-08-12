import { createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { hostReading, type Capacity } from "@/atlas/host-instruments"
import { identify } from "@/atlas/poll-identity"
import "@/atlas/HostStrip.css"

type HostStripProps = {
  request?: (path: string) => Promise<Response>
}

export function HostStrip(props: HostStripProps = {}): JSX.Element {
  const request = props.request ?? useSDK().request
  const client = identify()
  const load = () =>
    Promise.all([
      request(`/notebook/compute?client=${encodeURIComponent(client)}`).then((response) =>
        response.ok ? (response.json() as Promise<Capacity>) : undefined,
      ),
      request("/settings/compute/jobs")
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined),
    ])
      .then(([capacity, value]) => {
        if (!capacity || !Array.isArray(value)) return capacity
        const jobs = value as Array<{ status?: string; lifecycle?: { resource?: string } }>
        const live = jobs.filter(
          (job) =>
            !["succeeded", "failed", "cancelled", "interrupted"].includes(job.status ?? "") ||
            ["starting", "active", "unknown"].includes(job.lifecycle?.resource ?? ""),
        )
        return {
          ...capacity,
          jobs: { live: live.length, running: live.filter((job) => job.status === "running").length },
        }
      })
      .catch(() => undefined)
  const [data, api] = createResource(load)
  const reading = createMemo(() => hostReading(data.latest))
  const processDetail = () => {
    const detail = reading().kernels
    if (detail === "kernel count unavailable" || /^\d/.test(detail)) return detail
    return `${reading().live} ${detail}`
  }
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
        <span class="host-strip__label">Active</span>
        <p title={processDetail()} aria-label={`${reading().live} active processes. ${processDetail()}`}>
          <strong class="host-strip__kernels-value">{reading().live}</strong>
          <span>processes</span>
        </p>
      </div>
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
