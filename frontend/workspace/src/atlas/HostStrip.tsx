import { Index, createEffect, createMemo, createResource, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { histogram, hostReading, sample, type Capacity } from "@/atlas/host-instruments"
import { identify } from "@/atlas/poll-identity"
import "@/atlas/HostStrip.css"

// The transport is a prop so the degraded path can be mounted against a real
// endpoint that really fails; the session SDK supplies it in the product.
type HostStripProps = {
  request?: (path: string) => Promise<Response>
  // The tab labels carry a live kernel count, and this poll already asks for
  // it every 2.5s. Reporting it upward costs nothing; a second poller for the
  // same number would double the request rate on a route whose CPU figures are
  // measured per client across the window between polls.
  onKernels?: (live: number) => void
  // The kernel plates draw their RAM bar against the host's total and their
  // core segments against its core count. Both are already on this poll's
  // body, so lifting the reading here is cheaper — and always consistent with
  // the strip above — than giving every card its own /notebook/compute poll.
  onCapacity?: (capacity: Capacity) => void
}

// Names this mounted strip to the server. Both host and kernel CPU figures are
// measured across the window since the same client's previous poll, so two tabs
// sharing one identity would truncate each other's window to the gap between
// their polls — under the server's one-second floor, which then refuses a
// reading for whichever polled second, every cycle. See poll-identity.ts for
// why the identity is per mount rather than per module.

export function HostStrip(props: HostStripProps = {}): JSX.Element {
  const request = props.request ?? useSDK().request
  const client = identify()
  // A poll that fails resolves to no capacity instead of rejecting. An errored
  // resource re-throws where it is read, and the nearest ErrorBoundary wraps the
  // entire workspace, so a server restart or a sleep/wake while this pane is
  // open would swap the whole app for the error page. hostReading already reads
  // an absent capacity as unavailable, which is the designed degraded state —
  // never a 0, never a blank, never a thrown boundary.
  const load = () =>
    request(`/notebook/compute?client=${encodeURIComponent(client)}`)
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

  // Read `data.latest` rather than `data()`: `data()` re-registers with the
  // nearest Suspense boundary on every in-flight fetch, which suspends the
  // entire RightPane (see RightPane.tsx's Suspense around ComputeSurface) on
  // every 2.5s poll. `.latest` only suspends on the first load and returns the
  // previous value while a refetch is in flight, so this memo — and the pane
  // around it — stays mounted across polls.
  const reading = createMemo(() => hostReading(data.latest))

  // The histogram is the one thing here with memory. The route reports a point
  // in time, so the series has to be accumulated client-side; it is bounded to
  // SAMPLES, so this cannot grow without limit however long the pane stays open.
  const [history, setHistory] = createSignal<number[]>([])
  createEffect(() => {
    const capacity = data.latest
    if (capacity) setHistory((prior) => sample(prior, capacity))
  })
  const bars = createMemo(() => histogram(history()))

  createEffect(() => {
    // Only report a count the body actually carried. A poll that failed, or one
    // whose body arrived without the section, must leave the label showing the
    // last known figure rather than asserting zero kernels.
    const live = data.latest?.kernels?.live
    if (typeof live === "number") props.onKernels?.(live)
  })

  createEffect(() => {
    const capacity = data.latest
    if (capacity) props.onCapacity?.(capacity)
  })

  return (
    <section class="host-strip" aria-label="System statistics" data-testid="host-strip">
      {/* Named, because the figures below it are the machine's and the ones on
          each kernel plate are that kernel's, and nothing else on the surface
          said which was which — a reader who took "12.6 GB USED" for the
          kernel's own would be out by three orders of magnitude. */}
      <span class="host-strip__title">System statistics</span>
      <div class="host-strip__memory">
        <div class="host-strip__figure" data-host-tile="memory">
          <strong class="host-strip__headline">{reading().headline}</strong>
          <span class="host-strip__labels">
            <span class="host-strip__unit">{reading().unit}</span>
            <Show when={reading().ceiling}>
              <span class="host-strip__ceiling">{reading().ceiling}</span>
            </Show>
          </span>
        </div>
        {/* Decorative: the same series is already stated as a number beside it,
            so a screen reader gains nothing from twenty bar heights. */}
        <div class="host-strip__history" role="presentation" aria-hidden="true">
          <Index each={bars()}>
            {(bar) => (
              <span class="host-strip__bar" data-recent={bar().recent} style={{ height: `${bar().height}px` }} />
            )}
          </Index>
        </div>
      </div>

      <div class="host-strip__cores" data-host-tile="cpu">
        <span class="host-strip__cores-label">Cores</span>
        <span class="host-strip__segments" role="presentation">
          <Index each={Array.from({ length: reading().segments })}>
            {(_, position) => <span class="host-strip__segment" data-lit={position < reading().lit} />}
          </Index>
        </span>
        <span class="host-strip__cores-value">{reading().cores}</span>
      </div>
    </section>
  )
}
