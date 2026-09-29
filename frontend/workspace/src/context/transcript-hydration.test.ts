import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../test/vite"
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
const globalSync = (await server.ssrLoadModule("/src/context/global-sync.tsx")) as typeof import("./global-sync")
const sdkModule = (await server.ssrLoadModule("/src/context/sdk.tsx")) as typeof import("./sdk")
const syncModule = (await server.ssrLoadModule("/src/context/sync.tsx")) as typeof import("./sync")

const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  globalThis.localStorage?.clear()
})

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean, timeout = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for the workspace")
    await settle(10)
  }
}

const origin = "http://127.0.0.1:4096"
const directory = "/research/a"
const projectID = "prj_a"
// A project is opened with a projectID, so `scope` is the project id while the
// event stream publishes under the physical directory. Those two differ, which
// is the whole point of this test.
const scope = projectID
const sessionID = "ses_stream"

const projects: Project[] = [{ id: projectID, worktree: directory, time: { created: 1, updated: 1 }, sandboxes: [] }]

const text = (value: string) => ({ id: "prt_1", sessionID, messageID: "msg_1", type: "text", text: value })

/** The server, with `GET /session/{id}/message` held open so a sync is in
 * flight while the test pushes an event. */
function createFakeServer() {
  const encoder = new TextEncoder()
  const events = { controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }
  const pending = {
    controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
    requested: 0,
  }
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
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
      case `/session/${sessionID}`:
        return json({ id: sessionID, title: "streaming", time: { created: 1, updated: 1 } })
      case `/session/${sessionID}/message`:
        pending.requested += 1
        // The snapshot the workspace fetches when it enters the session. Held
        // open so the streamed event lands while the request is still in flight.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              pending.controller = controller
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      case "/path":
        return json({ home: "/home", state: "/state", config: "/config", worktree: directory, directory })
      case "/project":
        return json(projects)
      case "/project/current":
        return json(projects[0])
      case "/provider":
        return json({ all: [], connected: [], default: {} })
      case "/vcs":
        return json({ branch: "main" })
      case "/global/config":
      case "/config":
      case "/provider/auth":
      case "/session/status":
      case "/mcp":
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
    fetch,
    pending,
    // The stream keys each frame by the physical directory it belongs to; the
    // per-directory SDK then re-emits the payload to the sync context.
    push: (payload: unknown) => events.controller?.enqueue(frame({ directory, payload })),
    release: (messages: unknown) => {
      pending.controller?.enqueue(encoder.encode(JSON.stringify(messages)))
      pending.controller?.close()
    },
  }
}

type Sync = ReturnType<typeof syncModule.useSync>

function mount(fake: ReturnType<typeof createFakeServer>) {
  const host = document.createElement("div")
  document.body.append(host)
  const value: Platform = {
    platform: "web",
    openLink() {},
    back() {},
    forward() {},
    restart: async () => {},
    notify: async () => {},
    fetch: fake.fetch,
  }
  let captured: Sync | undefined
  let store: (() => { message: Record<string, unknown[]>; part: Record<string, unknown[]> }) | undefined
  const Capture = () => {
    captured = syncModule.useSync()
    const global = globalSync.useGlobalSync()
    const sdk = sdkModule.useSDK()
    store = () => global.child(sdk.directory)[0]
    return null
  }
  const tree = () => [
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
                    return web.createComponent(globalSync.GlobalSyncProvider, {
                      get children() {
                        return web.createComponent(sdkModule.SDKProvider, {
                          directory,
                          projectID,
                          get children() {
                            return web.createComponent(syncModule.SyncProvider, {
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
            })
          },
        })
      },
    }),
  ]
  cleanups.push(web.render(tree, host))
  return { sync: () => captured, store: () => store?.() }
}

test("a snapshot that predates a streamed part does not roll the transcript back", async () => {
  const fake = createFakeServer()
  const view = mount(fake)
  await until(() => view.sync() !== undefined)

  // Entering the session starts the snapshot fetch, which the fake server holds.
  const entering = view.sync()!.session.sync(sessionID)
  await until(() => fake.pending.requested > 0)

  // The agent streams while that request is still open, so the server has newer
  // text than the response the workspace is about to apply.
  fake.push({
    type: "message.part.updated",
    properties: { part: { ...text("the streamed, newer text"), time: { start: 1, end: 2 } } },
  })
  // Let the event reach the store before the snapshot lands.
  await until(() => (view.store()?.part.msg_1 ?? []).length > 0)

  fake.release([{ info: { id: "msg_1", sessionID, role: "assistant" }, parts: [text("the older snapshot text")] }])
  await entering

  const parts = (view.store()?.part.msg_1 ?? []) as { text?: string }[]
  expect(parts.map((part) => part.text)).toEqual(["the streamed, newer text"])
})
