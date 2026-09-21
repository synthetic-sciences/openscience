import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { Project } from "@synsci/sdk/v2/client"
import type { Platform } from "@/context/platform"
import { createTestServer } from "../../test/vite"

const server = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, external: ["fuzzysort"], resolve: { conditions: ["browser", "production"] } },
})
// Sequential: concurrent ssrLoadModule entries can each evaluate their own
// solid-js instance, and the fixture's providers would then hand their context
// to a different runtime than the one the layout reads it from.
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const fixture = (await server.ssrLoadModule(
  "/src/pages/directory-layout.fixture.tsx",
)) as typeof import("./directory-layout.fixture")
const toast = (await server.ssrLoadModule("@synsci/ui/toast")) as typeof import("@synsci/ui/toast")

const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  toast.toaster.clear()
  document.body.replaceChildren()
  globalThis.localStorage?.clear()
})

const project: Project = {
  id: "prj_a",
  worktree: "/research/a",
  time: { created: 1, updated: 1, activity: 1 },
  sandboxes: [],
}

type Hit = { path: string; directory?: string; project?: string }
type Answer = Response | Promise<Response> | undefined

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** An answer the test gives later, which is what a slow disk is to the layout:
 * a request that is still out. Every request waiting on it reads its own copy. */
function held() {
  const gate = Promise.withResolvers<Response>()
  return { response: () => gate.promise.then((response) => response.clone()), answer: gate.resolve }
}

/**
 * The server as a cold project route sees it. `answer` decides the requests a
 * test is about; everything else succeeds with an empty body of the right shape.
 */
function serve(answer: (hit: Hit) => Answer) {
  const encoder = new TextEncoder()
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const hit = {
      path: url.pathname,
      directory: request.headers.get("x-openscience-directory") ?? undefined,
      project: request.headers.get("x-openscience-project") ?? undefined,
    }
    const chosen = answer(hit)
    if (chosen) return chosen
    switch (hit.path) {
      case "/global/health":
        return json({ healthy: true, version: "test", sourceSha: null, sourceWorktreeHash: null, runId: "run" })
      case "/global/event":
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const connected = { payload: { type: "server.connected", properties: {} } }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(connected)}\n\n`))
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      case "/path":
        return json({
          home: "/home",
          state: "/state",
          config: "/config",
          worktree: hit.directory ?? "/cwd",
          directory: hit.directory ?? "/cwd",
        })
      case "/project":
        return json([project])
      case "/project/current":
        return json(project)
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
    return json({ error: "not_found", path: hit.path }, 404)
  }) as typeof globalThis.fetch
}

const opened = { count: 0 }

function open(path: string, fetch: typeof globalThis.fetch) {
  // The project catalog is cached per server, in memory as well as in storage.
  // A server of its own is what makes every test a first visit.
  const origin = `http://127.0.0.1:${4100 + opened.count++}`
  const host = document.createElement("div")
  document.body.append(host)
  const platform: Platform = {
    platform: "web",
    openLink() {},
    back() {},
    forward() {},
    restart: async () => {},
    notify: async () => {},
    fetch,
  }
  cleanups.push(web.render(fixture.createDirectoryLayoutFixture({ platform, url: origin, path }), host))
  return host
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeout = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for the layout")
    await settle(10)
  }
}

const loader = (host: HTMLElement) => host.querySelector('[data-component="loading-screen"]')
const caption = (host: HTMLElement) => loader(host)?.querySelector("synsci-loader")?.getAttribute("caption")
const route = (host: HTMLElement) => host.querySelector("[data-route]")?.getAttribute("data-route")

describe("a project route opened cold", () => {
  test("shows the loader until the catalog names the project, then the session", async () => {
    const catalog = held()
    const host = open(
      "/prj_a/session/ses_1",
      serve((hit) => (hit.path === "/project" ? catalog.response() : undefined)),
    )

    await until(() => Boolean(loader(host)))
    expect(loader(host)?.getAttribute("role")).toBe("status")
    expect(caption(host)).toBe("Opening session")
    expect(route(host)).toBeUndefined()

    catalog.answer(json([project]))
    await until(() => route(host) === "session")
    expect(loader(host)).toBeNull()
  })

  test("names the project when the URL carries no session yet", async () => {
    const host = open(
      "/prj_a/session",
      serve((hit) => (hit.path === "/project" ? held().response() : undefined)),
    )

    await until(() => Boolean(loader(host)))
    expect(caption(host)).toBe("Opening project")
  })

  test("keeps the loader through the project store's bootstrap, and opens on a failed one", async () => {
    const config = held()
    const host = open(
      "/prj_a/session/ses_1",
      serve((hit) => (hit.path === "/config" && hit.directory === project.worktree ? config.response() : undefined)),
    )

    // The catalog has answered and the project's providers are mounted, yet the
    // page is still the loader: the store behind them has nothing to show.
    await until(() => Boolean(loader(host)))
    await settle(50)
    expect(caption(host)).toBe("Opening session")
    expect(route(host)).toBeUndefined()

    config.answer(json({ name: "UnknownError", data: { message: "config unreadable" } }, 500))
    await until(() => route(host) === "session")
    expect(loader(host)).toBeNull()
  })

  test("sends an unknown project home instead of holding the loader", async () => {
    const host = open(
      "/prj_missing/session/ses_1",
      serve((hit) => {
        if (hit.path === "/project") return json([project])
        if (hit.path === "/project/current" && hit.project === "prj_missing")
          return json({ name: "NotFoundError", data: { message: "Project not found" } }, 404)
      }),
    )

    await until(() => route(host) === "home")
    expect(loader(host)).toBeNull()
    expect(document.body.textContent).toContain("Unknown project in URL.")
  })

  test("sends the user home when the server cannot be reached at all", async () => {
    const host = open(
      "/prj_a/session/ses_1",
      serve((hit) => (hit.path === "/global/event" ? undefined : Promise.reject(new TypeError("Failed to fetch")))),
    )

    await until(() => route(host) === "home")
    expect(loader(host)).toBeNull()
  })

  test("shows the recovery surface for a folder that is gone, not the loader", async () => {
    const host = open(
      "/prj_a/session/ses_1",
      serve((hit) => {
        if (hit.path !== "/project/current") return
        return json({ name: "ProjectStaleError", data: { reason: "missing_directory", directory: "/research/a" } }, 410)
      }),
    )

    await until(() => Boolean(host.querySelector(".project-unavailable")))
    expect(loader(host)).toBeNull()
    expect(host.textContent).toContain("/research/a")
  })
})
