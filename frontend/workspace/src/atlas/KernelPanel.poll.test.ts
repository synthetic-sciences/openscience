import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

// KernelPanel.tsx cannot be imported by bun directly: @solidjs/router resolves
// to solid's server build and throws a client-only API error at module load.
// Vite with browser conditions is the same loader HostStrip.test.ts uses.
//
// The panel itself is still not mountable in this focused harness: useSDK(),
// useSync(), and useParams() need the application providers, and no test here
// stands up that chain. The fetcher's degraded behaviour is therefore asserted
// at `inventory`, the seam the panel's load() calls; KernelPanel.test.ts pins
// the wiring from load() to it.
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const subject = (await vite.ssrLoadModule("/src/atlas/KernelPanel.tsx")) as typeof import("./KernelPanel")

afterAll(() => vite.close())

// An unbound high loopback port, so the connection failure comes from a real
// fetch rather than a rejection this test invented. happydom.ts replaces globalThis.Response,
// so a live Bun.serve endpoint cannot stand in for the product server here —
// see HostStrip.test.ts for the full reasoning.
const unreachable = "http://127.0.0.1:65535"

describe("kernel panel poll", () => {
  test("only reports no active compute after both inventories succeed", () => {
    expect(subject.freshness({ runtime: "", remote: "", runtimeSeen: false, remoteSeen: false }).empty).toBe(
      "Reading compute…",
    )
    expect(subject.freshness({ runtime: "", remote: "", runtimeSeen: true, remoteSeen: true }).empty).toBe(
      "No active compute",
    )
  })

  test("distinguishes unavailable inventory from a stale successful inventory", () => {
    const unavailable = subject.freshness({
      runtime: "offline",
      remote: "",
      runtimeSeen: false,
      remoteSeen: true,
    })
    const stale = subject.freshness({ runtime: "offline", remote: "", runtimeSeen: true, remoteSeen: true })

    expect(unavailable).toMatchObject({ stale: false, empty: "Compute unavailable" })
    expect(stale).toMatchObject({ stale: true, empty: "Compute activity may be out of date" })
  })

  test("resolves to no inventory when the server cannot be reached", async () => {
    const reported: string[] = []

    const value = await subject.inventory(Bun.fetch(`${unreachable}/kernels`), (error) => reported.push(error))

    // Resolved, not rejected: an errored resource re-throws where the render
    // path reads it, and the only ErrorBoundary in the app wraps the whole
    // workspace — one failed 2.5s poll would replace the entire UI.
    expect(value).toBeUndefined()
    expect(reported.length).toBe(1)
    expect(reported[0]).not.toBe("")
  })

  test("resolves to no inventory when the server answers an error status", async () => {
    const response = new Response("kernel registry unavailable", { status: 503 })
    const reported: string[] = []
    // Exactly what the panel's request wrapper does with a non-ok response.
    const rejected = Promise.reject(new Error(await response.text()))

    const value = await subject.inventory(rejected, (error) => reported.push(error))

    expect(value).toBeUndefined()
    expect(reported).toEqual(["kernel registry unavailable"])
  })

  test("never leaves a rejection for the render path to re-throw", async () => {
    const settled = subject.inventory(Promise.reject(new Error("boom")), () => {})

    await expect(settled).resolves.toBeUndefined()
  })

  test("returns the last successful inventory when a refresh fails", async () => {
    const previous = { kernels: [{ id: "kernel-python" }] }
    const reported: string[] = []

    const value = await subject.inventory(
      Promise.reject(new Error("temporary disconnect")),
      (error) => reported.push(error),
      previous,
    )

    expect(value).toBe(previous)
    expect(reported).toEqual(["temporary disconnect"])
  })

  test("passes a successful body through and clears the error it reported", async () => {
    const kernels = { kernels: [] }
    const reported: string[] = []

    const first = await subject.inventory(Promise.reject(new Error("boom")), (error) => reported.push(error))
    const second = await subject.inventory(Promise.resolve(kernels), (error) => reported.push(error))

    expect(first).toBeUndefined()
    expect(second).toBe(kernels)
    expect(reported).toEqual(["boom", ""])
  })

  test("runs the completion callback only for successful inventories", async () => {
    const previous = { kernels: [] }
    const completed: string[] = []
    const complete = () => completed.push("sample")

    await subject.inventory(Promise.resolve(previous), () => {}, undefined, complete)
    await subject.inventory(Promise.reject(new Error("boom")), () => {}, previous, complete)

    expect(completed).toEqual(["sample"])
  })
})
