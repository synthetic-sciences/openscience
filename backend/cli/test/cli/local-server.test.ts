import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DESKTOP_SERVER_FILE,
  advertiseDesktopServer,
  localServerBase,
  localWorkspaceUrl,
  findWorkspaceServer,
  probeLocalServer,
  probeWorkspaceServer,
  readDesktopServer,
  withdrawDesktopServer,
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

  test("asks for the bundle's version file the way the server serves it", async () => {
    // The real router answers an API-shaped request for an unmatched route
    // with a JSON 404 before it serves any file from the workspace bundle.
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const route = new URL(request.url).pathname
        if (route === "/global/health") return Response.json({ healthy: true, version: "2.0.50" })
        const accept = request.headers.get("accept") ?? ""
        if (accept.includes("application/json") && !accept.includes("text/html")) {
          return Response.json({ error: "not_found", path: route }, { status: 404 })
        }
        if (route === "/version.json") return Response.json({ version: "2.0.50", channel: "latest" })
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    expect(await probeWorkspaceServer(localServerBase(server.port), "2.0.50")).toBe(true)
  })

  test("opens a project through the compatible directory route", () => {
    const target = localWorkspaceUrl("http://localhost:4096", "/Users/research/Titanic study")
    expect(target).toMatch(/^http:\/\/localhost:4096\/[A-Za-z0-9_-]+\/session$/)
    expect(target).not.toContain("Titanic study")
  })
})

describe("desktop app server discovery", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  async function dataRoot() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-desktop-discovery-"))
    directories.push(dir)
    return dir
  }

  function workspace(version: string) {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const route = new URL(request.url).pathname
        if (route === "/global/health") return Response.json({ healthy: true, version })
        if (route === "/version.json") return Response.json({ version, channel: "latest" })
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    return server
  }

  async function deadPid() {
    const proc = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" })
    const pid = proc.pid
    await proc.exited
    return pid
  }

  test("attaches to the app's random port before probing the stable ones", async () => {
    const dir = await dataRoot()
    const app = workspace("2.0.60")
    const other = workspace("2.0.60")
    await advertiseDesktopServer(dir, { port: app.port!, pid: process.pid, version: "2.0.60" })

    expect(await findWorkspaceServer("2.0.60", [other.port!], dir)).toBe(app.port)
  })

  test("records the port, pid, version and start time the terminal validates against", async () => {
    const dir = await dataRoot()
    const before = Date.now()
    await advertiseDesktopServer(dir, { port: 51234, pid: process.pid, version: "2.0.60" })

    const record = await readDesktopServer(dir)
    expect(record).toMatchObject({ schema: 1, port: 51234, pid: process.pid, version: "2.0.60" })
    expect(Date.parse(record!.started_at)).toBeGreaterThanOrEqual(before - 1000)
  })

  test("ignores a record whose process is gone", async () => {
    const dir = await dataRoot()
    const app = workspace("2.0.60")
    const fallback = workspace("2.0.60")
    await advertiseDesktopServer(dir, { port: app.port!, pid: await deadPid(), version: "2.0.60" })

    expect(await findWorkspaceServer("2.0.60", [fallback.port!], dir)).toBe(fallback.port)
  })

  test("ignores a record left by another version", async () => {
    const dir = await dataRoot()
    const app = workspace("2.0.59")
    const fallback = workspace("2.0.60")
    await advertiseDesktopServer(dir, { port: app.port!, pid: process.pid, version: "2.0.59" })

    expect(await findWorkspaceServer("2.0.60", [fallback.port!], dir)).toBe(fallback.port)
  })

  test("ignores a record whose port stopped answering", async () => {
    const dir = await dataRoot()
    const app = workspace("2.0.60")
    const port = app.port!
    await advertiseDesktopServer(dir, { port, pid: process.pid, version: "2.0.60" })
    await app.stop(true)

    expect(await findWorkspaceServer("2.0.60", [], dir)).toBeUndefined()
  })

  test("ignores an unreadable, truncated or foreign file", async () => {
    const dir = await dataRoot()
    const file = path.join(dir, DESKTOP_SERVER_FILE)
    const fallback = workspace("2.0.60")

    for (const contents of ['{"schema":1,"port":4', "[]", '{"schema":2,"port":5000,"pid":2,"version":"2.0.60"}']) {
      await Bun.write(file, contents)
      expect(await readDesktopServer(dir)).toBeUndefined()
      expect(await findWorkspaceServer("2.0.60", [fallback.port!], dir)).toBe(fallback.port)
    }
    expect(await readDesktopServer(await dataRoot())).toBeUndefined()
  })

  test("withdraws its own advertisement and leaves the next server's alone", async () => {
    const dir = await dataRoot()
    await advertiseDesktopServer(dir, { port: 51234, pid: process.pid, version: "2.0.60" })
    withdrawDesktopServer(dir, process.pid)
    expect(await readDesktopServer(dir)).toBeUndefined()

    await advertiseDesktopServer(dir, { port: 51235, pid: process.pid, version: "2.0.60" })
    withdrawDesktopServer(dir, process.pid + 1)
    expect(await readDesktopServer(dir)).toMatchObject({ port: 51235 })

    // An exit handler runs after the file is already gone as often as not.
    withdrawDesktopServer(await dataRoot(), process.pid)
  })
})
