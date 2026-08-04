import { For, createResource, onCleanup, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { hostTiles, type Capacity } from "@/atlas/host-tiles"
import "@/atlas/HostStrip.css"

export function HostStrip(): JSX.Element {
  const sdk = useSDK()
  const load = () =>
    sdk.request("/notebook/compute").then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return response.json() as Promise<Capacity>
    })
  const [data, api] = createResource(load)
  const timer = setInterval(() => {
    if (document.hidden) return
    void api.refetch()
  }, 2_500)
  onCleanup(() => clearInterval(timer))

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
