import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web, core] = await Promise.all([
  vite.ssrLoadModule("/src/atlas/HostStrip.tsx") as Promise<typeof import("./HostStrip")>,
  vite.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  vite.ssrLoadModule("solid-js") as Promise<typeof import("solid-js")>,
])

// Shaped like a real /notebook/compute body, so the populated tiles are read
// off the same JSON the route serves.
const capacity = {
  memory: { total: 16_000_000_000, available: 9_300_000_000, kernels: 412_000_000 },
  cpu: { cores: 8, busy: 2.1, kernels: 0.4 },
  kernels: { live: 2, running: 1 },
}

// A live Bun.serve endpoint cannot stand in for the product server under this
// suite: happydom.ts replaces globalThis.Response, so Bun.serve does not
// recognise what a handler returns and answers with its own placeholder body
// carrying a doubled content-length. Every request would then fail for a reason
// that has nothing to do with the subject, and the degraded-state tests would
// pass without the error status ever reaching the component. So the connection
// failure uses a genuinely closed port over Bun's own fetch, and the statuses a
// running server returns are real Response objects over fixture bodies.
const closed = Bun.serve({ port: 0, fetch: () => new Response("") })
const unreachable = `http://127.0.0.1:${closed.port}`
await closed.stop(true)

const offline = (path: string) => Bun.fetch(`${unreachable}${path}`)
const erroring = async () => new Response("kernel registry unavailable", { status: 503 })
const serving = async () => new Response(JSON.stringify(capacity), { headers: { "content-type": "application/json" } })

const cleanups: Array<() => void> = []

afterAll(() => vite.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

// The product mounts this strip inside the workspace-wide ErrorBoundary, so a
// thrown poll would replace the entire app. The boundary is part of the subject.
const guard = (view: () => JSX.Element) =>
  mount(() =>
    core.createComponent(core.ErrorBoundary, {
      fallback: () => {
        const caught = document.createElement("p")
        caught.dataset.boundary = "caught"
        caught.textContent = "boundary"
        return caught
      },
      get children() {
        return view()
      },
    }),
  )

const track = (respond: (path: string) => Promise<Response>, calls: Array<Promise<Response>>) => (path: string) => {
  const pending = respond(path)
  calls.push(pending)
  return pending
}

const settle = async (calls: Array<Promise<Response>>) => {
  await Promise.allSettled(calls)
  await Bun.sleep(20)
}

const values = (host: HTMLElement) =>
  [...host.querySelectorAll(".host-strip__value")].map((element) => element.textContent)

describe("host strip", () => {
  test("reads Unavailable on every tile when the server cannot be reached", async () => {
    const calls: Array<Promise<Response>> = []
    const host = guard(() => subject.HostStrip({ request: track(offline, calls) }))
    await settle(calls)

    expect(calls.length).toBeGreaterThan(0)
    await expect(calls[0]).rejects.toThrow()
    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(host.querySelectorAll(".host-strip__tile").length).toBe(3)
    expect(values(host)).toEqual(["Unavailable", "Unavailable", "Unavailable"])
    expect(host.textContent).not.toContain("0 B")
    expect(host.textContent).not.toContain("0.0 cores")
  })

  test("reads Unavailable on every tile when the server answers an error status", async () => {
    const calls: Array<Promise<Response>> = []
    const host = guard(() => subject.HostStrip({ request: track(erroring, calls) }))
    await settle(calls)

    expect((await calls[0])?.status).toBe(503)
    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(host.querySelectorAll(".host-strip__tile").length).toBe(3)
    expect(values(host)).toEqual(["Unavailable", "Unavailable", "Unavailable"])
    expect(host.textContent).not.toContain("0 B")
    expect(host.textContent).not.toContain("0.0 cores")
  })

  test("states the machine's capacity once a poll succeeds", async () => {
    const calls: Array<Promise<Response>> = []
    const host = guard(() => subject.HostStrip({ request: track(serving, calls) }))
    await settle(calls)

    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(values(host)).toEqual(["412 MB", "0.4 cores", "2"])
    expect(host.textContent).toContain("~2 of 8 cores busy")
  })

  test("asks the route the compute strip is served from", async () => {
    const paths: string[] = []
    guard(() =>
      subject.HostStrip({
        request: (path: string) => {
          paths.push(path)
          return serving()
        },
      }),
    )
    await Bun.sleep(20)

    expect(paths).toEqual(["/notebook/compute"])
  })

  test("keeps the same tile nodes mounted across a poll that changes the data", async () => {
    // The regression this guards: For is keyed by referential identity, and
    // every poll parses a brand new response body. Swapping For for Index (and
    // memoizing the tile computation) should mean a data change patches text
    // and meter widths in place rather than tearing down and remounting the
    // tile. Capturing the node before the second poll and asserting `toBe`
    // (identity, not toEqual) after it is what actually catches a regression
    // back to For — a component that just re-renders correct values would
    // still pass a toEqual check on text alone.
    let capacity = {
      memory: { total: 16_000_000_000, available: 9_300_000_000, kernels: 412_000_000 },
      cpu: { cores: 8, busy: 2.1, kernels: 0.4 },
      kernels: { live: 2, running: 1 },
    }
    const respond = async () =>
      new Response(JSON.stringify(capacity), { headers: { "content-type": "application/json" } })
    const calls: Array<Promise<Response>> = []
    const host = guard(() => subject.HostStrip({ request: track(respond, calls) }))
    await settle(calls)

    const memoryTile = host.querySelector('[data-host-tile="memory"]')
    const cpuTile = host.querySelector('[data-host-tile="cpu"]')
    const kernelsTile = host.querySelector('[data-host-tile="kernels"]')
    expect(memoryTile).not.toBeNull()
    expect(values(host)).toEqual(["412 MB", "0.4 cores", "2"])

    capacity = {
      memory: { total: 16_000_000_000, available: 5_000_000_000, kernels: 900_000_000 },
      cpu: { cores: 8, busy: 4.4, kernels: 1.1 },
      kernels: { live: 5, running: 3 },
    }
    document.dispatchEvent(new Event("visibilitychange"))
    await settle(calls)

    // Identity: the very same element instances are still the ones mounted.
    expect(host.querySelector('[data-host-tile="memory"]')).toBe(memoryTile)
    expect(host.querySelector('[data-host-tile="cpu"]')).toBe(cpuTile)
    expect(host.querySelector('[data-host-tile="kernels"]')).toBe(kernelsTile)
    expect(host.contains(memoryTile)).toBe(true)
    // Freshness: the values inside those same nodes actually moved.
    expect(values(host)).toEqual(["900 MB", "1.1 cores", "5"])
  })

  test("refreshes when the tab is shown again and polls nothing after unmount", async () => {
    const calls: Array<Promise<Response>> = []
    guard(() => subject.HostStrip({ request: track(serving, calls) }))
    await settle(calls)
    const polled = calls.length

    document.dispatchEvent(new Event("visibilitychange"))
    await settle(calls)

    expect(calls.length).toBe(polled + 1)

    cleanups.splice(0).forEach((cleanup) => cleanup())
    document.dispatchEvent(new Event("visibilitychange"))
    // Longer than the 2.5s poll, so a surviving interval would show up here.
    await Bun.sleep(2_700)

    expect(calls.length).toBe(polled + 1)
  })
})
