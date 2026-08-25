import { afterEach, describe, expect, test } from "bun:test"
import { localServerBase, localWorkspaceUrl, probeLocalServer } from "../../src/cli/local-server"

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

  test("opens a project through the compatible directory route", () => {
    const target = localWorkspaceUrl("http://localhost:4096", "/Users/research/Titanic study")
    expect(target).toMatch(/^http:\/\/localhost:4096\/[A-Za-z0-9_-]+\/session$/)
    expect(target).not.toContain("Titanic study")
  })
})
