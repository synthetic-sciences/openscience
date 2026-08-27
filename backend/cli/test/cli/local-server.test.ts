import { afterEach, describe, expect, test } from "bun:test"
import {
  localServerBase,
  localWorkspaceUrl,
  findWorkspaceServer,
  probeLocalServer,
  probeWorkspaceServer,
} from "../../src/cli/local-server"

const servers: Bun.Server<unknown>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

describe("local OpenScience server reuse", () => {
  test("recognizes only a healthy OpenScience endpoint", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/global/health") {
          return Response.json({ healthy: true, version: "2.0.40" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    expect(await probeLocalServer(localServerBase(server.port))).toBe(true)
  })

  test("does not reuse an unrelated listener", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("hello") })
    servers.push(server)

    expect(await probeLocalServer(localServerBase(server.port))).toBe(false)
  })

  test("reuses only a matching browser workspace, not an API-only or stale server", async () => {
    const version = { current: "2.0.50" }
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: version.current })
        if (path === "/version.json") return Response.json({ version: version.current, channel: "latest" })
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    const base = localServerBase(server.port)

    expect(await probeWorkspaceServer(base, "2.0.50")).toBe(true)
    expect(await probeWorkspaceServer(base, "2.0.49")).toBe(false)

    version.current = "2.0.49"
    expect(await probeWorkspaceServer(base, "2.0.50")).toBe(false)
  })

  test("does not mistake a healthy source API for the packaged workspace", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/global/health") {
          return Response.json({ healthy: true, version: "2.0.50" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const base = localServerBase(server.port)
    expect(await probeLocalServer(base)).toBe(true)
    expect(await probeWorkspaceServer(base, "2.0.50")).toBe(false)
  })

  test("finds the matching stable workspace origin in preference order", async () => {
    const stale = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "2.0.49" })
        if (path === "/version.json") return Response.json({ version: "2.0.49", channel: "latest" })
        return new Response("not found", { status: 404 })
      },
    })
    const current = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "2.0.50" })
        if (path === "/version.json") return Response.json({ version: "2.0.50", channel: "latest" })
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(stale, current)

    expect(await findWorkspaceServer("2.0.50", [stale.port!, current.port!])).toBe(current.port)
    expect(await findWorkspaceServer("2.0.51", [stale.port!, current.port!])).toBeUndefined()
  })

  test("opens a project through the compatible directory route", () => {
    const target = localWorkspaceUrl("http://localhost:4096", "/Users/research/Titanic study")
    expect(target).toMatch(/^http:\/\/localhost:4096\/[A-Za-z0-9_-]+\/session$/)
    expect(target).not.toContain("Titanic study")
  })
})
