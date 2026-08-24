import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
const [subject, web, core, suspenseFixture] = await Promise.all([
  vite.ssrLoadModule("/src/atlas/HostStrip.tsx") as Promise<typeof import("./HostStrip")>,
  vite.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  vite.ssrLoadModule("solid-js") as Promise<typeof import("solid-js")>,
  vite.ssrLoadModule("/src/atlas/host-strip-suspense-fixture.tsx") as Promise<
    typeof import("./host-strip-suspense-fixture")
  >,
])

// Shaped like a real /notebook/compute body, so the populated tiles are read
// off the same JSON the route serves.
const capacity = {
  memory: { total: 16_000_000_000, available: 9_300_000_000, kernels: 412_000_000 },
  cpu: { cores: 8, busy: 2.1, kernels: 0.4 },
  kernels: { live: 2, running: 1 },
}

// A live test endpoint cannot stand in for the product server under this
// suite: happydom.ts replaces globalThis.Response, so Bun.serve does not
// recognise what a handler returns and answers with its own placeholder body
// carrying a doubled content-length. Every request would then fail for a reason
// that has nothing to do with the subject, and the degraded-state tests would
// pass without the error status ever reaching the component. So the connection
// failure uses an unbound high loopback port over Bun's own fetch, and the
// statuses a running server returns are real Response objects over fixtures.
// Avoid opening a listener here: restricted test runners may forbid all binds.
const unreachable = "http://127.0.0.1:65535"

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
  [host.querySelector(".host-strip__headline"), host.querySelector(".host-strip__cores-value")].map(
    (element) => element?.textContent,
  )

describe("host strip", () => {
  test("reads unavailable on every instrument when the server cannot be reached", async () => {
    const calls: Array<Promise<Response>> = []
    const host = guard(() => subject.HostStrip({ request: track(offline, calls) }))
    await settle(calls)

    expect(calls.length).toBeGreaterThan(0)
    await expect(calls[0]).rejects.toThrow()
    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(host.querySelectorAll(".host-strip__metric").length).toBe(3)
    expect(values(host)).toEqual(["—", "—"])
    expect(host.textContent).not.toContain("0 B")
    expect(host.textContent).not.toContain("0 / 0")
  })

  test("reads unavailable on every instrument when the server answers an error status", async () => {
    const calls: Array<Promise<Response>> = []
    const host = guard(() => subject.HostStrip({ request: track(erroring, calls) }))
    await settle(calls)

    expect((await calls[0])?.status).toBe(503)
    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(host.querySelectorAll(".host-strip__metric").length).toBe(3)
    expect(values(host)).toEqual(["—", "—"])
    expect(host.textContent).not.toContain("0 B")
    expect(host.textContent).not.toContain("0 / 0")
  })

  test("names the block as machine resources", () => {
    const source = readFileSync(fileURLToPath(new URL("./HostStrip.tsx", import.meta.url)), "utf8")

    expect(source).toContain('<span class="host-strip__label">Memory</span>')
    expect(source).toContain('<span class="host-strip__label">Kernels</span>')
    expect(source).toContain('aria-label="Current local compute"')
    expect(source).not.toContain("<details")
    expect(source).not.toContain("<summary")
  })

  test("states the machine's capacity once a poll succeeds", async () => {
    const calls: Array<Promise<Response>> = []
    const host = guard(() => subject.HostStrip({ request: track(serving, calls) }))
    await settle(calls)

    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(values(host)).toEqual(["412.0 MB", "~0.4 of 8"])
    expect(host.textContent).toContain("of 16.0 GB")
    expect(host.textContent).toContain("2kernels · 1 running")
    expect(host.querySelector('[data-host-tile="kernels"] p')?.getAttribute("aria-label")).toBe("2 kernels, 1 running")
    expect(host.querySelector("details")).toBeNull()
    expect(host.querySelector("summary")).toBeNull()
  })

  test("asks the route the compute strip is served from, naming itself to the server", async () => {
    const paths: string[] = []
    const track = (path: string) => {
      paths.push(path)
      return serving()
    }
    guard(() => subject.HostStrip({ request: track }))
    await Bun.sleep(20)

    expect(paths).toHaveLength(1)
    expect(paths).not.toContain("/settings/compute/jobs")
    const asked = new URL(paths.find((path) => path.startsWith("/kernels/compute")) ?? "", "http://host")
    expect(asked.pathname).toBe("/kernels/compute")

    // Both CPU figures the route serves are measured across the window since
    // the SAME client's previous poll, so a second tab sharing this identity
    // would truncate that window to the gap between the two tabs' polls — under
    // the server's one-second floor, which then refuses whichever polled
    // second, every cycle. A second mount must therefore not reuse the first's.
    const client = asked.searchParams.get("client")
    expect(client).toBeTruthy()

    const others: string[] = []
    guard(() =>
      subject.HostStrip({
        request: (path: string) => {
          others.push(path)
          return serving()
        },
      }),
    )
    await Bun.sleep(20)

    expect(others).toHaveLength(1)
    const other = others.find((path) => path.startsWith("/kernels/compute")) ?? ""
    expect(new URL(other, "http://host").searchParams.get("client")).not.toBe(client)
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
    expect(memoryTile).not.toBeNull()
    expect(values(host)).toEqual(["412.0 MB", "~0.4 of 8"])

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
    expect(host.contains(memoryTile)).toBe(true)
    // Freshness: the values inside those same nodes actually moved.
    expect(values(host)).toEqual(["900.0 MB", "~1.1 of 8"])
  })

  test("stays mounted with no Suspense fallback while a poll is genuinely in flight", async () => {
    // The regression this guards: RightPane.tsx wraps ComputeSurface (and so
    // HostStrip) in a <Suspense>. Reading the resource with `data()` re-registers
    // with that boundary on every in-flight fetch — including a background poll —
    // which suspends the whole pane until the request resolves. Reading
    // `data.latest` instead only suspends on the very first load and returns the
    // previous value while a refetch is outstanding. A transport that resolves
    // immediately can never distinguish the two, so this holds the second
    // request open with a deferred promise to create a real window where the
    // fetch is in flight, then asserts directly inside that window.
    //
    // This is mounted through host-strip-suspense-fixture.tsx rather than the
    // guard()/core.createComponent(core.Suspense, ...) pattern used elsewhere in
    // this file: Suspense's internal effect-resumption needs to run on the same
    // solid-js module instance as the render() root, and the fixture's
    // HostStrip + Suspense + render all come from one file's import graph so
    // they share an instance; core and web here are loaded as separate
    // ssrLoadModule calls and do not.
    const refreshed = {
      memory: { total: 16_000_000_000, available: 5_000_000_000, kernels: 900_000_000 },
      cpu: { cores: 8, busy: 4.4, kernels: 1.1 },
      kernels: { live: 5, running: 3 },
    }
    let settleSecond: ((response: Response) => void) | undefined
    let requests = 0
    const respond = (path: string): Promise<Response> => {
      if (path === "/settings/compute/jobs") {
        return Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } }))
      }
      requests += 1
      if (requests === 1) return serving()
      return new Promise<Response>((resolve) => (settleSecond = resolve))
    }
    const fallback = () => {
      const marker = document.createElement("p")
      marker.dataset.fallback = "true"
      marker.textContent = "loading host strip"
      return marker
    }

    const host = document.createElement("div")
    document.body.append(host)
    cleanups.push(suspenseFixture.mountHostStripInSuspense(respond, fallback, host))

    // Let the first load resolve; the fallback should be gone and tiles present.
    await Bun.sleep(20)
    expect(host.querySelector("[data-fallback]")).toBeNull()
    expect(values(host)).toEqual(["412.0 MB", "~0.4 of 8"])
    const memoryTile = host.querySelector('[data-host-tile="memory"]')
    expect(memoryTile).not.toBeNull()

    // Trigger a refetch and let it reach the transport, but hold it open.
    document.dispatchEvent(new Event("visibilitychange"))
    await Bun.sleep(20)
    expect(requests).toBe(2)
    expect(settleSecond).toBeDefined()

    // While the second request is genuinely unresolved: no fallback, and the
    // captured tile node is still the one mounted in the document.
    expect(host.querySelector("[data-fallback]")).toBeNull()
    expect(memoryTile?.isConnected).toBe(true)
    expect(host.querySelector('[data-host-tile="memory"]')).toBe(memoryTile)
    expect(values(host)).toEqual(["412.0 MB", "~0.4 of 8"])

    // Resolve it and confirm the value actually moved.
    settleSecond?.(new Response(JSON.stringify(refreshed), { headers: { "content-type": "application/json" } }))
    await Bun.sleep(20)

    expect(host.querySelector("[data-fallback]")).toBeNull()
    expect(host.querySelector('[data-host-tile="memory"]')).toBe(memoryTile)
    expect(values(host)).toEqual(["900.0 MB", "~1.1 of 8"])
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
