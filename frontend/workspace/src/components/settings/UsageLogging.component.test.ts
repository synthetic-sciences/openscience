import type { SettingsUsageLoggingHealthResponses } from "@synsci/sdk/v2/client"
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
    status: {
      enabled: true,
      signedIn: true,
      queued: 3,
      delivered: 7,
      quarantined: 0,
      lastDelivery: undefined as string | undefined,
      error,
    },
    reject: false,
    health: undefined as SettingsUsageLoggingHealthResponses[200] | undefined,
    healthReads: 0,
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
    if (request.url === "/settings/usage-logging/health") {
      state.healthReads++
      return json(state.health ?? { state: "unavailable", reason: "unsupported" })
    }
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

test("delivery errors preserve counts and refresh shows rejected records and acknowledgement time", async () => {
  const { state, host } = await mount("Trace delivery was not accepted (HTTP 503).")
  expect(host.textContent).toContain("3 queued · 7 acknowledged")
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("HTTP 503")
  expect(host.textContent).toContain("No delivery has been acknowledged")
  state.status.quarantined = 2
  state.status.lastDelivery = "2026-10-18T10:00:00.000Z"
  host.querySelector<HTMLButtonElement>("button")!.click()
  await ready(() => host.textContent?.includes("2 rejected records") === true)
  expect(host.textContent).toContain("2026-10-18T10:00:00.000Z")
  expect(host.textContent).toContain("not retried automatically")
  expect(host.textContent).toContain("does not verify complete model usage")
  expect(state.writes).toEqual([])
  expect(host.querySelector<HTMLInputElement>("input")?.checked).toBe(true)
})

const healthy: SettingsUsageLoggingHealthResponses[200] = {
  state: "available",
  report: {
    schema_version: 1,
    scope: "account_installation_workspace",
    status: "healthy",
    since: "2026-10-18T00:00:00Z",
    until: "2026-10-18T01:00:00Z",
    checked_at: "2026-10-18T01:00:01Z",
    receipts: { deliveries: 1, anomalous: 0, orphaned_events: 0 },
    usage: {
      responses: 1,
      projected: 1,
      missing_projection: 0,
      unknown_input: 0,
      unknown_output: 0,
      unknown_reasoning: 1,
      unknown_cache_read: 0,
      unknown_cache_write: 1,
    },
    managed: {
      responses: 0,
      pending: 0,
      settled: 0,
      not_charged: 0,
      missing_call_id: 0,
      missing_link: 0,
      ambiguous_link: 0,
      missing_hold: 0,
      hold_mismatch: 0,
      settled_missing_charge: 0,
      duplicate_charge: 0,
      token_mismatch: 0,
      charge_amount_mismatch: 0,
      unknown_charge_amount: 0,
    },
  },
}
const checkServer = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Check server")!

test("server checks are explicit and keep local queue evidence separate from stored evidence", async () => {
  const { state, host } = await mount()
  state.health = healthy
  expect(state.healthReads).toBe(0)
  checkServer(host).click()
  await ready(() => host.textContent?.includes("No discrepancies found") === true)
  expect(state.healthReads).toBe(1)
  expect(host.textContent).toContain("3 queued · 7 acknowledged")
  expect(host.textContent).toContain("3 queued and 0 rejected records are outside the server report")
  expect(host.textContent).toContain("1 model responses · 1 usage records")
  expect(host.textContent).toContain("An omitted field is not a token-count mismatch")
  state.status.signedIn = false
  window.dispatchEvent(new Event("openscience:account-changed"))
  await ready(() => checkServer(host).disabled)
  await ready(() => host.textContent?.includes("No records are sent while signed out") === true)
  await ready(() => host.querySelector<HTMLInputElement>("input")?.disabled === false)
  expect(host.textContent).not.toContain("No discrepancies found")
})

test("older servers remain explicitly unavailable and do not hide device delivery status", async () => {
  const { host } = await mount()
  checkServer(host).click()
  await ready(() => host.textContent?.includes("does not support logging-health reports yet") === true)
  expect(host.textContent).toContain("3 queued · 7 acknowledged")
  expect(host.textContent).not.toContain("No discrepancies found")
})
