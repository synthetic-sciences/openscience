import { For, createResource, onCleanup, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { hostTiles, type Capacity } from "@/atlas/host-tiles"
import "@/atlas/HostStrip.css"

// The transport is a prop so the degraded path can be mounted against a real
// endpoint that really fails; the session SDK supplies it in the product.
type HostStripProps = { request?: (path: string) => Promise<Response> }

export function HostStrip(props: HostStripProps = {}): JSX.Element {
  const request = props.request ?? useSDK().request
  // A poll that fails resolves to no capacity instead of rejecting. An errored
  // resource re-throws where it is read, and the nearest ErrorBoundary wraps the
  // entire workspace, so a server restart or a sleep/wake while this pane is
  // open would swap the whole app for the error page. hostTiles already reads an
  // absent capacity as "Unavailable" on every tile, which is the designed
  // degraded state — never a 0, never a blank tile, never a thrown boundary.
  const load = () =>
    request("/notebook/compute")
      .then((response) => (response.ok ? (response.json() as Promise<Capacity>) : undefined))
      .catch(() => undefined)
  const [data, api] = createResource(load)
  // A hidden tab skips its polls, so returning to it would otherwise show
  // numbers up to one interval stale until the next tick.
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
    <section class="host-strip" aria-label="Host capacity" data-testid="host-strip">
      <For each={hostTiles(data())}>
        {(tile) => (
          <div class="host-strip__tile" data-host-tile={tile.key}>
            <div class="host-strip__reading">
              <strong class="host-strip__value">{tile.value}</strong>
              <span class="host-strip__caption">{tile.caption}</span>
            </div>
            <div class="host-strip__meter" role="presentation">
              <span class="host-strip__fill" style={{ width: `${tile.fill * 100}%` }} />
              <span class="host-strip__share" style={{ width: `${tile.share * 100}%` }} />
            </div>
          </div>
        )}
      </For>
    </section>
  )
}
