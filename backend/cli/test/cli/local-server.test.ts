import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
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

  test("reuses a port only when the server there is the run the caller expects", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "2.0.50", runId: "run-a" })
        if (path === "/version.json") return Response.json({ version: "2.0.50", channel: "latest" })
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    const base = localServerBase(server.port)

    expect(await probeLocalServer(base, "run-a")).toBe(true)
    expect(await probeLocalServer(base, "run-b")).toBe(false)
    expect(await probeWorkspaceServer(base, "2.0.50", "run-a")).toBe(true)
    expect(await probeWorkspaceServer(base, "2.0.50", "run-b")).toBe(false)
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

  function workspace(version: string, runId = randomUUID()) {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const route = new URL(request.url).pathname
        if (route === "/global/health") return Response.json({ healthy: true, version, runId })
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
    const runId = randomUUID()
    const app = workspace("2.0.60", runId)
    const other = workspace("2.0.60")
    await advertiseDesktopServer(dir, { port: app.port!, pid: process.pid, version: "2.0.60", runId })

    expect(await findWorkspaceServer("2.0.60", [other.port!], dir)).toBe(app.port)
  })

  test("records the port, pid, version, run id and start time the terminal validates against", async () => {
    const dir = await dataRoot()
    const before = Date.now()
    await advertiseDesktopServer(dir, { port: 51234, pid: process.pid, version: "2.0.60", runId: "run-60" })

    const record = await readDesktopServer(dir)
    expect(record).toMatchObject({ schema: 1, port: 51234, pid: process.pid, version: "2.0.60", run_id: "run-60" })
    expect(Date.parse(record!.started_at)).toBeGreaterThanOrEqual(before - 1000)
  })

  test("ignores a record whose process is gone", async () => {
    const dir = await dataRoot()
    const app = workspace("2.0.60")
    const fallback = workspace("2.0.60")
    await advertiseDesktopServer(dir, { port: app.port!, pid: await deadPid(), version: "2.0.60", runId: "run-60" })

    expect(await findWorkspaceServer("2.0.60", [fallback.port!], dir)).toBe(fallback.port)
  })

  test("ignores a record left by another version", async () => {
    const dir = await dataRoot()
    const app = workspace("2.0.59")
    const fallback = workspace("2.0.60")
    await advertiseDesktopServer(dir, { port: app.port!, pid: process.pid, version: "2.0.59", runId: "run-59" })

    expect(await findWorkspaceServer("2.0.60", [fallback.port!], dir)).toBe(fallback.port)
  })

  test("ignores a record whose port answers as a different server run", async () => {
    // Nothing but a file write is needed to name a port, so the record has to
    // carry something only the process that wrote it can answer with.
    const dir = await dataRoot()
    const planted = workspace("2.0.60")
    const fallback = workspace("2.0.60")
    await advertiseDesktopServer(dir, {
      port: planted.port!,
      pid: process.pid,
      version: "2.0.60",
      runId: "never-listened-here",
    })

    expect(await findWorkspaceServer("2.0.60", [fallback.port!], dir)).toBe(fallback.port)
  })

  test("ignores a record whose port stopped answering", async () => {
    const dir = await dataRoot()
    const runId = randomUUID()
    const app = workspace("2.0.60", runId)
    const port = app.port!
    await advertiseDesktopServer(dir, { port, pid: process.pid, version: "2.0.60", runId })
    await app.stop(true)

    expect(await findWorkspaceServer("2.0.60", [], dir)).toBeUndefined()
  })

  test("ignores an unreadable, truncated or foreign file", async () => {
    const dir = await dataRoot()
    const file = path.join(dir, DESKTOP_SERVER_FILE)
    const fallback = workspace("2.0.60")

    for (const contents of [
      '{"schema":1,"port":4',
      "[]",
      '{"schema":2,"port":5000,"pid":2,"version":"2.0.60"}',
      '{"schema":1,"port":5000,"pid":2,"version":"2.0.60","started_at":"2026-09-20T00:00:00.000Z"}',
    ]) {
      await Bun.write(file, contents)
      expect(await readDesktopServer(dir)).toBeUndefined()
      expect(await findWorkspaceServer("2.0.60", [fallback.port!], dir)).toBe(fallback.port)
    }
    expect(await readDesktopServer(await dataRoot())).toBeUndefined()
  })

  test("sweeps the temporary files of writers that are gone and spares a live one", async () => {
    const dir = await dataRoot()
    // The live writer goes first: while it holds its pid, no exited process
    // can be handed the same one, so the two names cannot collide.
    const live = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 10_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    const inFlight = path.join(dir, `${DESKTOP_SERVER_FILE}.${live.pid}.tmp`)
    const orphan = path.join(dir, `${DESKTOP_SERVER_FILE}.${await deadPid()}.tmp`)
    const unrelated = path.join(dir, "notes.tmp")
    await Promise.all([Bun.write(orphan, "{}"), Bun.write(inFlight, "{}"), Bun.write(unrelated, "{}")])

    try {
      await advertiseDesktopServer(dir, { port: 51236, pid: process.pid, version: "2.0.60", runId: "run-60" })

      expect(await Bun.file(orphan).exists()).toBe(false)
      expect(await Bun.file(inFlight).exists()).toBe(true)
      expect(await Bun.file(unrelated).exists()).toBe(true)
      expect(await readDesktopServer(dir)).toMatchObject({ port: 51236 })
    } finally {
      live.kill()
      await live.exited
    }
  })

  test("withdraws its own advertisement and leaves the next server's alone", async () => {
    const dir = await dataRoot()
    await advertiseDesktopServer(dir, { port: 51234, pid: process.pid, version: "2.0.60", runId: "run-60" })
    withdrawDesktopServer(dir, process.pid)
    expect(await readDesktopServer(dir)).toBeUndefined()

    await advertiseDesktopServer(dir, { port: 51235, pid: process.pid, version: "2.0.60", runId: "run-60" })
    withdrawDesktopServer(dir, process.pid + 1)
    expect(await readDesktopServer(dir)).toMatchObject({ port: 51235 })

    // An exit handler runs after the file is already gone as often as not.
    withdrawDesktopServer(await dataRoot(), process.pid)
  })

  test("leaves a record it cannot read behind and clears bytes that are nobody's", async () => {
    const dir = await dataRoot()
    const file = path.join(dir, DESKTOP_SERVER_FILE)

    // A schema from the future belongs to the newer sidecar that wrote it.
    const future = '{"schema":2,"port":51237,"pid":2,"version":"2.0.61"}'
    await Bun.write(file, future)
    withdrawDesktopServer(dir, process.pid)
    expect(await Bun.file(file).text()).toBe(future)

    // A half-written or clobbered file is not a record anyone can own, and
    // would shadow every later advertisement if it stayed.
    await Bun.write(file, '{"schema":1,"port":5')
    withdrawDesktopServer(dir, process.pid)
    expect(await Bun.file(file).exists()).toBe(false)
  })

  test("does not throw out of an exit handler when the record cannot be read", async () => {
    const dir = await dataRoot()
    // A directory in the record's place fails every read and removal the
    // withdrawal attempts, on every platform and without depending on how the
    // suite's user is privileged.
    await fs.mkdir(path.join(dir, DESKTOP_SERVER_FILE))
    expect(() => withdrawDesktopServer(dir, process.pid)).not.toThrow()
    expect((await fs.stat(path.join(dir, DESKTOP_SERVER_FILE))).isDirectory()).toBe(true)

    // An exception thrown from an `exit` handler leaves the process with a
    // non-zero status, which is what the sidecar's shutdown must never inherit.
    const module = new URL("../../src/cli/local-server.ts", import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { withdrawDesktopServer } = await import(${JSON.stringify(module)})
         process.once("exit", () => withdrawDesktopServer(${JSON.stringify(dir)}, process.pid))`,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          OPENSCIENCE_DATA_DIR: path.join(dir, "child-data"),
          OPENSCIENCE_CONFIG_DIR: path.join(dir, "child-config"),
          OPENSCIENCE_TEST_HOME: path.join(dir, "child-home"),
        },
      },
    )

    expect(await child.exited).toBe(0)
  })
})
