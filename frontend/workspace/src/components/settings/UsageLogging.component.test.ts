import { afterAll, afterEach, expect, test } from "bun:test"
import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule(
  "/src/components/settings/UsageLogging.tsx",
)) as typeof import("./UsageLogging")
const cleanups: Array<() => void> = []
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
  expect(check()).toBe(true)
}

async function mount(error?: string) {
  const state = {
    status: { enabled: true, signedIn: true, queued: 3, delivered: 7, quarantined: 0, error },
    reject: false,
    writes: [] as { enabled: boolean }[],
  }
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, PUT, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      response.end(JSON.stringify(value))
    }
    if (request.method === "OPTIONS") return json(null, 204)
    if (request.url !== "/settings/usage-logging") return json({}, 404)
    if (request.method === "PUT") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { enabled: boolean }
      state.writes.push(body)
      if (state.reject) return json({ message: "Preference could not be saved" }, 503)
      state.status.enabled = body.enabled
      if (!body.enabled) state.status.queued = 0
    }
    return json(state.status)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      subject.UsageLogging({
        services: { sdk: { url: `http://127.0.0.1:${address.port}` }, platform: { fetch } },
      }),
    host,
  )
  cleanups.push(() => {
    dispose()
    server.closeAllConnections()
    server.close()
  })
  const input = () => host.querySelector<HTMLInputElement>("input")!
  await ready(() => input()?.disabled === false)
  return { state, host, input }
}

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("the trace switch shows confirmed delivery and persists an explicit opt-out", async () => {
  const { state, host, input } = await mount()
  expect(input().checked).toBe(true)
  expect(host.textContent).toContain("3 queued · 7 acknowledged")
  input().click()
  await ready(() => host.textContent?.includes("Sharing is off") === true)
  expect(state.writes).toEqual([{ enabled: false }])
  expect(input().checked).toBe(false)
  expect(state.status.queued).toBe(0)
})

test("a rejected preference write keeps the saved state and exposes the failure", async () => {
  const { state, host, input } = await mount()
  state.reject = true
  input().click()
  await ready(() => host.querySelector('[role="alert"]') !== null)
  expect(state.writes).toEqual([{ enabled: false }])
  expect(input().checked).toBe(true)
  expect(input().disabled).toBe(false)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Please retry")
})

test("refresh removes a resolved delivery error instead of retaining stale status", async () => {
  const { state, host } = await mount("Trace delivery could not be verified")
  expect(host.textContent).toContain("could not be verified")
  state.status.error = undefined
  state.status.queued = 0
  state.status.delivered = 10
  host.querySelector<HTMLButtonElement>("button")!.click()
  await ready(() => host.textContent?.includes("10 acknowledged") === true)
  expect(host.textContent).not.toContain("could not be verified")
})
