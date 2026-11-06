import { describe, expect, test } from "bun:test"
import { probeServerHealth, SERVER_HEALTH_TIMEOUT_MS } from "./server-probe"

// The workspace suite runs under happydom, which replaces the global Response
// that Bun.serve relies on, so a live listener cannot stand in for the server
// here. A fetch fixture still exercises the real probe, SDK request and abort
// path against the same Request object the generated client builds.
function delayedFetch(body: unknown, delayMs: number): typeof fetch {
  const respond = (input: RequestInfo | URL) => {
    const signal = input instanceof Request ? input.signal : undefined
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })),
        delayMs,
      )
      signal?.addEventListener("abort", () => {
        clearTimeout(timer)
        reject(signal.reason)
      })
    })
  }
  return respond as typeof fetch
}

describe("server health probe", () => {
  test("waits past the slowest healthy answer measured in #1042", () => {
    expect(SERVER_HEALTH_TIMEOUT_MS).toBeGreaterThan(9_000)
  })

  test("reports a slow but live server as healthy", async () => {
    const fetch = delayedFetch({ healthy: true, version: "2.0.153" }, 250)

    expect(await probeServerHealth("http://127.0.0.1:4661", fetch, 1_000)).toEqual({
      healthy: true,
      version: "2.0.153",
    })
  })

  test("reports a stall that outlives the probe deadline as unhealthy", async () => {
    const fetch = delayedFetch({ healthy: true }, 250)

    expect(await probeServerHealth("http://127.0.0.1:4661", fetch, 20)).toEqual({ healthy: false })
  })
})
