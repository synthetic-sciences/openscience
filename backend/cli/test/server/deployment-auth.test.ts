import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

const key = "OPENSCIENCE_AUTH_TOKEN"
const previous = process.env[key]
const token = "shared-lab-secret"

const request = (headers?: HeadersInit) =>
  Server.App().fetch(
    new Request("http://localhost/global/project", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    }),
  )

describe.serial("deployment authentication", () => {
  beforeAll(() => {
    process.env[key] = token
  })

  afterAll(() => {
    if (previous === undefined) delete process.env[key]
    if (previous !== undefined) process.env[key] = previous
  })

  test("rejects an unauthenticated network request", async () => {
    const response = await request()
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="openscience"')
  })

  test("passes deployment auth through to route validation", async () => {
    const response = await request({ authorization: `Bearer ${token}` })
    expect(response.status).toBe(400)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })

  test("keeps health open for liveness probes", async () => {
    const response = await Server.App().fetch(new Request("http://localhost/global/health"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ healthy: true })
  })

  test("allows real CORS preflights but not ordinary OPTIONS requests", async () => {
    const preflight = await Server.App().fetch(
      new Request("http://localhost/global/project", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.syntheticsciences.ai",
          "access-control-request-method": "POST",
        },
      }),
    )
    expect(preflight.status).not.toBe(401)

    const ordinary = await Server.App().fetch(new Request("http://localhost/global/project", { method: "OPTIONS" }))
    expect(ordinary.status).toBe(401)
  })

  test("keeps trusted in-process calls exempt", async () => {
    const response = await Server.internalFetch()("http://openscience.internal/global/project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).not.toBe(401)
  })
})
