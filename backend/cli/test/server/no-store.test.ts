import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const fetch = Server.internalFetch()

// 410/404 are cacheable by default (RFC 7231 §6.1), and the API sent no
// Cache-Control at all. A browser cached one stale-project 410 for /provider and
// then answered every later request from its own cache — the server saw no
// traffic while the app stayed broken through restarts and reloads.
describe("API responses are never cached", () => {
  test("a successful JSON response is marked no-store", async () => {
    const response = await fetch("http://openscience.internal/provider")

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("an error response is marked no-store", async () => {
    const response = await fetch("http://openscience.internal/provider", {
      headers: { "x-openscience-project": `prj_missing_${crypto.randomUUID()}` },
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})
