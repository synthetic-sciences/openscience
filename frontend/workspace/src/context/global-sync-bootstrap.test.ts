import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { Project } from "@synsci/sdk/v2/client"
import type { Platform } from "@/context/platform"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
// Sequential: concurrent ssrLoadModule entries can each evaluate their own
// solid-js instance, and the providers below would then hand their context to
// a different runtime than the one the subject reads it from.
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const platform = (await server.ssrLoadModule("/src/context/platform.tsx")) as typeof import("./platform")
const serverContext = (await server.ssrLoadModule("/src/context/server.tsx")) as typeof import("./server")
const language = (await server.ssrLoadModule("/src/context/language.tsx")) as typeof import("./language")
const globalSdk = (await server.ssrLoadModule("/src/context/global-sdk.tsx")) as typeof import("./global-sdk")
const subject = (await server.ssrLoadModule("/src/context/global-sync.tsx")) as typeof import("./global-sync")
// The same module instance the subject toasts through, so a mounted region
// shows exactly what the user would see.
const toast = (await server.ssrLoadModule("@synsci/ui/toast")) as typeof import("@synsci/ui/toast")

const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  toast.toaster.clear()
  document.body.replaceChildren()
  globalThis.localStorage?.clear()
})

const toasts = () => document.querySelectorAll('[data-component="toast"]')

const origin = "http://127.0.0.1:4096"
// The server's own worktree: the install catalog is read through it during the
// global bootstrap, and that instance exists before any project is opened.
const cwd = "/cwd"

function project(id: string, worktree: string, activity: number): Project {
  return { id, worktree, time: { created: 1, updated: 1, activity }, sandboxes: [] }
}

type Hit = { path: string; directory?: string; project?: string; body?: Record<string, unknown> }

/**
 * The server as the workspace sees it: every route the bootstrap touches,
 * a global event stream the test can push events into, and a record of the
 * project selector each request carried. Requests scoped to a directory in
 * `broken` fail the way the server's directory validation does for a folder
 * that no longer exists.
 */
function createFakeServer(projects: Project[]) {
  const hits: Hit[] = []
  const broken = new Set<string>()
  const encoder = new TextEncoder()
  const events = { controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }
  const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const directory = request.headers.get("x-openscience-directory") ?? undefined
    const selector = request.headers.get("x-openscience-project") ?? undefined
    const body = url.pathname === "/log" ? ((await request.json()) as Record<string, unknown>) : undefined
    hits.push({ path: url.pathname, directory, project: selector, body })
    if (directory && broken.has(directory)) {
      return new Response(JSON.stringify({ name: "ProjectDirectoryError", data: { directory } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
    switch (url.pathname) {
      case "/global/health":
        return json({ healthy: true, version: "test", sourceSha: null, sourceWorktreeHash: null, runId: "run" })
      case "/global/event": {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            events.controller = controller
            controller.enqueue(frame({ payload: { type: "server.connected", properties: {} } }))
          },
        })
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      case "/path":
        return json({
          home: "/home",
          state: "/state",
          config: "/config",
          worktree: directory ?? cwd,
          directory: directory ?? cwd,
        })
      case "/project":
        return json(projects)
      case "/project/current":
        return json(projects.find((item) => item.worktree === directory) ?? projects[0])
      case "/provider":
        return json({ all: [], connected: [], default: {} })
      case "/vcs":
        return json({ branch: "main" })
      case "/global/config":
      case "/config":
      case "/provider/auth":
      case "/session/status":
      case "/mcp":
        return json({})
      case "/agent":
      case "/command":
      case "/skill":
      case "/session":
      case "/lsp":
      case "/permission":
      case "/question":
        return json([])
      case "/log":
        return json(true)
    }
    return new Response(JSON.stringify({ error: "not_found", path: url.pathname }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return {
    hits,
    broken,
    fetch,
    emit(payload: unknown, directory = "global") {
      events.controller?.enqueue(frame({ directory, payload }))
    },
    /** Every project directory any request was scoped to. */
    directories: () => new Set(hits.map((hit) => hit.directory).filter((item): item is string => !!item)),
  }
}

function mount(fetch: typeof globalThis.fetch) {
  const host = document.createElement("div")
  document.body.append(host)
  const value: Platform = {
    platform: "web",
    openLink() {},
    back() {},
    forward() {},
    restart: async () => {},
    notify: async () => {},
    fetch,
  }
  let captured: ReturnType<typeof subject.useGlobalSync> | undefined
  const Capture = () => {
    captured = subject.useGlobalSync()
    return null
  }
  const tree = () => [
    web.createComponent(toast.Toast.Region, {}),
    web.createComponent(platform.PlatformProvider, {
      value,
      get children() {
        return web.createComponent(serverContext.ServerProvider, {
          defaultUrl: origin,
          get children() {
            return web.createComponent(language.LanguageProvider, {
              get children() {
                return web.createComponent(globalSdk.GlobalSDKProvider, {
                  get children() {
                    return web.createComponent(subject.GlobalSyncProvider, {
                      get children() {
                        return web.createComponent(Capture, {})
                      },
                    })
                  },
                })
              },
            })
          },
        })
      },
    }),
  ]
  cleanups.push(web.render(tree, host))
  return () => captured
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeout = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for the workspace")
    await settle(10)
  }
}

const projects = [
  project("prj_a", "/research/a", 10),
  project("prj_b", "/research/b", 30),
  project("prj_c", "/research/c", 20),
]

describe("project bootstrap", () => {
  test("a project route bootstraps only the active project, through catalog refreshes and reconnects", async () => {
    const fake = createFakeServer(projects)
    const sync = mount(fake.fetch)
    await until(() => !!sync())
    const app = sync()!

    // Home cards, sidebar entries and notification lookups own metadata-only
    // child stores for every known project.
    for (const item of projects) app.child(item.worktree, { bootstrap: false, projectID: item.id })
    // The route being opened.
    app.child("/research/a", { projectID: "prj_a" })

    await until(() => app.ready && app.child("/research/a", { bootstrap: false })[0].status === "complete")
    await settle(subject.CATALOG_DELAY_MS + subject.PREFETCH_DELAY_MS + 150)
    expect(fake.directories()).toEqual(new Set([cwd, "/research/a"]))

    // The project's catalogs still arrive, after the session list.
    for (const path of ["/command", "/skill", "/mcp", "/lsp"]) {
      expect(fake.hits.some((hit) => hit.path === path && hit.directory === "/research/a")).toBe(true)
    }

    // Managed pricing landing on the server refreshes the provider catalog.
    fake.emit({ type: "global.disposed", properties: {} })
    await settle(250)
    expect(fake.directories()).toEqual(new Set([cwd, "/research/a"]))

    // A reconnect re-bootstraps what was open, never the cards.
    fake.emit({ type: "server.connected", properties: {} })
    await settle(400)
    expect(fake.directories()).toEqual(new Set([cwd, "/research/a"]))

    // The skill fan-out is gated the same way.
    fake.emit({ type: "skill.updated", properties: {} })
    await settle(250)
    expect(fake.directories()).toEqual(new Set([cwd, "/research/a"]))

    const reports = fake.hits.filter((hit) => hit.body?.service === "startup" && hit.body?.message === "interactive")
    expect(reports).toHaveLength(1)
  })

  test("Home warms only the most recently used project, after the launch screen paints", async () => {
    const fake = createFakeServer(projects)
    const sync = mount(fake.fetch)
    await until(() => !!sync())
    const app = sync()!
    for (const item of projects) app.child(item.worktree, { bootstrap: false, projectID: item.id })

    await until(() => app.ready)
    expect(fake.directories()).toEqual(new Set([cwd]))

    const [store] = app.child("/research/b", { bootstrap: false })
    await settle(subject.PREFETCH_DELAY_MS + 400)
    expect(fake.directories()).toEqual(new Set([cwd, "/research/b"]))
    await until(() => store.status === "complete")
    const reports = fake.hits.filter((hit) => hit.body?.service === "startup" && hit.body?.message === "interactive")
    expect(reports).toHaveLength(1)
    expect(reports[0]?.body?.extra).toMatchObject({ phase: "home" })

    // The warmup stops short of the catalogs: MCP status would start the
    // project's MCP servers for a folder nobody opened this session.
    const catalogs = ["/command", "/skill", "/mcp", "/lsp"]
    const scoped = (path: string) => fake.hits.filter((hit) => hit.path === path && hit.directory === "/research/b")
    await settle(subject.CATALOG_DELAY_MS + 150)
    for (const path of catalogs) expect(scoped(path)).toHaveLength(0)

    // Opening the warmed project fetches them, without a second bootstrap.
    const bootstraps = scoped("/project/current").length
    app.child("/research/b", { projectID: "prj_b" })
    await until(() => catalogs.every((path) => scoped(path).length === 1))
    expect(scoped("/project/current")).toHaveLength(bootstraps)
  })

  test("a disposed server instance is re-pushed only for a project that was opened", async () => {
    const fake = createFakeServer(projects)
    const sync = mount(fake.fetch)
    await until(() => !!sync())
    const app = sync()!
    for (const item of projects) app.child(item.worktree, { bootstrap: false, projectID: item.id })
    app.child("/research/a", { projectID: "prj_a" })
    await until(() => app.ready && app.child("/research/a", { bootstrap: false })[0].status === "complete")
    await settle(subject.CATALOG_DELAY_MS + subject.PREFETCH_DELAY_MS + 150)

    // The stream's opening server.connected can land after ready and re-push
    // the open project once, so count bootstraps from here.
    const current = (directory: string) =>
      fake.hits.filter((hit) => hit.path === "/project/current" && hit.directory === directory)
    const bootstraps = current("/research/a").length
    expect(bootstraps).toBeGreaterThan(0)

    // A card-only project: the server released an instance the workspace
    // never asked for, so there is nothing to bring back.
    fake.emit({ type: "server.instance.disposed", properties: { directory: "/research/c" } }, "/research/c")
    await settle(250)
    expect(fake.directories()).toEqual(new Set([cwd, "/research/a"]))
    expect(current("/research/a")).toHaveLength(bootstraps)

    // The opened project is bootstrapped again.
    fake.emit({ type: "server.instance.disposed", properties: { directory: "/research/a" } }, "/research/a")
    await until(() => current("/research/a").length === bootstraps + 1)
    expect(fake.directories()).toEqual(new Set([cwd, "/research/a"]))
  })

  test("a failed warmup stays quiet and leaves the project to bootstrap on an explicit open", async () => {
    const fake = createFakeServer(projects)
    // The most recent project's folder is gone: every request scoped to it
    // fails directory validation on the server.
    fake.broken.add("/research/b")
    const sync = mount(fake.fetch)
    await until(() => !!sync())
    const app = sync()!
    for (const item of projects) app.child(item.worktree, { bootstrap: false, projectID: item.id })

    await until(() => app.ready)
    await settle(subject.PREFETCH_DELAY_MS + 400)
    const scoped = () => fake.hits.filter((hit) => hit.directory === "/research/b")
    const current = () => scoped().filter((hit) => hit.path === "/project/current")
    expect(current()).toHaveLength(1)

    // Nothing on the launch screen: no toast, and the project looks untouched.
    const [store] = app.child("/research/b", { bootstrap: false })
    expect(store.status).toBe("loading")
    expect(toasts()).toHaveLength(0)

    // Reconnect and catalog fan-outs no longer carry the failed directory.
    const before = scoped().length
    fake.emit({ type: "server.connected", properties: {} })
    fake.emit({ type: "global.disposed", properties: {} })
    fake.emit({ type: "skill.updated", properties: {} })
    await settle(400)
    expect(scoped()).toHaveLength(before)

    // An explicit open bootstraps again, and its failure is the user's to see.
    app.child("/research/b", { projectID: "prj_b" })
    await until(() => current().length === 2)
    await until(() => store.status === "partial")
    await until(() => toasts().length === 1)
  })
})

describe("recentProject", () => {
  test("prefers substantive activity, falls back to creation, and skips archived projects", () => {
    const archived = {
      ...project("prj_z", "/research/z", 99),
      time: { created: 1, updated: 1, activity: 99, archived: 5 },
    }
    const created = { ...project("prj_d", "/research/d", 0), time: { created: 25, updated: 25 } }
    expect(subject.recentProject([...projects, archived, created])?.id).toBe("prj_b")
    expect(subject.recentProject([projects[0]!, created])?.id).toBe("prj_d")
    expect(subject.recentProject([archived])).toBeUndefined()
    expect(subject.recentProject([])).toBeUndefined()
  })
})
