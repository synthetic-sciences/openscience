import { afterAll, afterEach, expect, test } from "bun:test"
import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { usageRange, type UsageRow } from "@synsci/util/usage"
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
const subject = (await vite.ssrLoadModule("/src/components/settings/Usage.tsx")) as typeof import("./Usage")
const cleanups: Array<() => void> = []
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
  expect(check()).toBe(true)
}
const sample = (route: UsageRow["route"], cost: number): UsageRow => ({
  date: usageRange().end,
  route,
  cost,
  model: `${route}-model`,
  provider: route,
  calls: 1,
  tokens: 120,
  input: 100,
  output: 20,
  reasoning: 10,
  cacheRead: 0,
  cacheWrite: 0,
})
async function mount(connected = true) {
  const state = { connected, fail: false, requests: [] as URL[] }
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost")
    if (request.method !== "OPTIONS") state.requests.push(url)
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      response.end()
      return
    }
    response.writeHead(state.fail ? 503 : 200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    })
    response.end(
      JSON.stringify(
        state.fail
          ? { message: "Usage unavailable" }
          : url.pathname.endsWith("managed")
            ? { connected: state.connected, rows: state.connected ? [sample("managed", 2)] : [] }
            : { connected: true, rows: [sample("byok", 0.2), sample("local", 0), sample("unknown", 0.1)] },
      ),
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected loopback listener")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () => subject.default({ services: { sdk: { url: `http://127.0.0.1:${address.port}` }, platform: { fetch } } }),
    host,
  )
  cleanups.push(() => {
    dispose()
    server.closeAllConnections()
    server.close()
  })
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)!
  await ready(() => !button("Refresh").disabled)
  return { host, state, button }
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("source controls separate billed, own-key, local, and historical usage", async () => {
  const { host, button } = await mount()
  expect(host.querySelector("tbody")?.textContent).toContain("managed-model")
  button("API keys").click()
  expect(host.querySelector("tbody")?.textContent).toContain("byok-model")
  expect(host.querySelector("tbody")?.textContent).not.toContain("managed-model")
  expect(host.querySelector("dl")?.textContent).toContain("$0.20")
  button("Local models").click()
  expect(host.querySelector("tbody")?.textContent).toContain("local-model")
  expect(host.querySelector("dl")?.textContent).toContain("$0.00")
  button("Unclassified").click()
  expect(host.querySelector("tbody")?.textContent).toContain("unknown-model")
  button("Subscriptions").click()
  expect(host.textContent).toContain("No activity for these dates")
  expect(button("Export CSV").disabled).toBe(true)
})

test("date presets request both sources and invalid ranges cannot export", async () => {
  const { host, state, button } = await mount()
  const period = host.querySelector("select")!
  period.value = "7"
  period.dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => state.requests.filter((url) => url.searchParams.get("start") === usageRange(7).start).length === 2)
  await ready(() => !button("Refresh").disabled)
  const end = host.querySelector<HTMLInputElement>('[aria-label="To date"]')!
  end.value = "2020-01-01"
  end.dispatchEvent(new Event("input", { bubbles: true }))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Choose valid dates")
  expect(button("Export CSV").disabled).toBe(true)
})

test("signed-out managed usage leaves local usage available and failures can retry", async () => {
  const { host, state, button } = await mount(false)
  expect(host.textContent).toContain("Connect your Synthetic Sciences account")
  button("API keys").click()
  await ready(() => !button("Export CSV").disabled)
  state.fail = true
  button("Refresh").click()
  await ready(() => !!host.querySelector('[role="alert"]'))
  expect(button("Export CSV").disabled).toBe(true)
  state.fail = false
  button("Retry").click()
  await ready(() => !button("Export CSV").disabled)
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

test("CSV download contains only the active source with its filename and cost basis", async () => {
  const { button } = await mount()
  const files: { blob: Blob; name: string }[] = []
  const create = URL.createObjectURL
  const click = HTMLAnchorElement.prototype.click
  const blobs = new Map<string, Blob>()
  URL.createObjectURL = (blob) => {
    if (!(blob instanceof Blob)) throw new Error("Expected a CSV blob")
    const url = create(blob)
    blobs.set(url, blob)
    return url
  }
  HTMLAnchorElement.prototype.click = function () {
    files.push({ blob: blobs.get(this.href)!, name: this.download })
  }
  cleanups.push(() => {
    URL.createObjectURL = create
    HTMLAnchorElement.prototype.click = click
  })
  button("Export CSV").click()
  button("API keys").click()
  await ready(() => !button("Export CSV").disabled)
  button("Export CSV").click()
  expect(files).toHaveLength(2)
  expect(files[0].name).toContain("openscience-managed-usage-")
  expect(await files[0].blob.text()).toContain('"managed-model"')
  expect(await files[0].blob.text()).toContain('"Wallet charge"')
  expect(files[1].name).toContain("openscience-byok-usage-")
  expect(await files[1].blob.text()).toContain('"byok-model"')
  expect(await files[1].blob.text()).not.toContain('"managed-model"')
  expect(await files[1].blob.text()).toContain('"Estimate"')
})

test("account changes invalidate cached managed usage while the settings panel stays mounted", async () => {
  const { host, state, button } = await mount()
  expect(host.querySelector("tbody")?.textContent).toContain("managed-model")
  state.connected = false
  window.dispatchEvent(new Event("openscience:account-changed"))
  expect(host.querySelector("tbody")).toBeNull()
  await ready(() => host.textContent?.includes("Connect your Synthetic Sciences account") === true)
  expect(button("Export CSV").disabled).toBe(true)
  button("API keys").click()
  await ready(() => !button("Export CSV").disabled)
})
