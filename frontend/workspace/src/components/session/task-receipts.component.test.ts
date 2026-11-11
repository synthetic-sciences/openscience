import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { SessionReceiptsResponses } from "@synsci/sdk/v2/client"
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
const solidjs = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const subject = (await vite.ssrLoadModule(
  "/src/components/session/task-receipts.tsx",
)) as typeof import("./task-receipts")
const cleanups: (() => void)[] = []
const report = (): SessionReceiptsResponses[200] => ({
  rootSessionID: "session",
  sessions: 3,
  managedCalls: 2,
  missingCallIDs: 0,
  state: "available",
  checkedAt: "2026-10-18T00:00:00Z",
  chargedMicrousd: "1",
  calls: [
    { call_id: "settled", state: "settled", receipt_id: "receipt", hold_id: "hold" },
    { call_id: "pending", state: "pending", receipt_id: null, hold_id: "pending-hold" },
  ],
  receipts: [
    {
      receipt_id: "receipt",
      hold_id: "hold",
      charged_microusd: "1",
      settled_at: "2026-10-18T00:00:00Z",
      provider: "openrouter",
      model: "worker-model",
    },
  ],
})
function mount(load: () => Promise<SessionReceiptsResponses[200]>, version?: () => string) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.TaskReceipts({
          sessionID: "session",
          load,
          get version() {
            return version?.()
          },
        }),
      host,
    ),
  )
  return host
}
async function click(host: HTMLElement) {
  host.querySelector("button")!.click()
  await Bun.sleep(30)
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("settled receipts are checked explicitly and preserve sub-cent amounts alongside pending workers", async () => {
  let checks = 0
  const host = mount(async () => {
    checks++
    return report()
  })
  expect(checks).toBe(0)
  await click(host)
  expect(checks).toBe(1)
  expect(host.textContent).toContain("Includes 2 worker sessions")
  expect(host.textContent).toContain("Settled receipts subtotal: USD 0.000001")
  expect(host.textContent).toContain("worker-model")
  expect(host.textContent).toContain("Receipt receipt · Hold hold")
  expect(host.textContent).toContain("Pending: 1")
  expect(host.textContent).toContain("This subtotal is incomplete")
})

test("no receipts and unknown calls are never displayed as a free task", async () => {
  const host = mount(async () => ({ ...report(), chargedMicrousd: "0", receipts: [], missingCallIDs: 1, calls: [] }))
  await click(host)
  expect(host.textContent).toContain("No settled receipts available")
  expect(host.textContent).toContain("Unknown or missing: 1")
  expect(host.textContent).not.toContain("subtotal: USD 0")
})

test("account changes clear receipts and discard a late response from the previous account", async () => {
  const pending = Promise.withResolvers<SessionReceiptsResponses[200]>()
  const host = mount(() => pending.promise)
  host.querySelector("button")!.click()
  window.dispatchEvent(new Event("openscience:account-changed"))
  pending.resolve(report())
  await Bun.sleep(30)
  expect(host.textContent).not.toContain("USD 0.000001")
  expect(host.textContent).not.toContain("worker-model")
  expect(host.querySelector("button")!.disabled).toBe(false)
})

test("an older receipt server remains explicitly unavailable", async () => {
  const host = mount(async () => ({
    ...report(),
    state: "unavailable",
    reason: "unsupported",
    receipts: [],
    calls: [],
  }))
  await click(host)
  expect(host.textContent).toContain("does not support per-call receipts yet")
  expect(host.textContent).not.toContain("subtotal")
})

test("an explicit settled zero is shown as evidence rather than a missing amount", async () => {
  const fixture = report()
  const host = mount(async () => ({
    ...fixture,
    managedCalls: 1,
    chargedMicrousd: "0",
    calls: [fixture.calls[0]!],
    receipts: [{ ...fixture.receipts[0]!, charged_microusd: "0" }],
  }))
  await click(host)
  expect(host.textContent).toContain("Settled receipts subtotal: USD 0.000000")
  expect(host.textContent).not.toContain("No settled receipts available")
  expect(host.textContent).not.toContain("This subtotal is incomplete")
})

test("the cost summary shows only checked Wallet charges", async () => {
  const host = mount(async () => report())
  const summary = () => host.querySelector('[aria-label="Cost so far"]')!
  expect(summary().textContent).toContain("Not checked")
  expect(summary().textContent).not.toContain("Estimated")
  await click(host)
  expect(summary().textContent).toContain("USD 0.000001")
  expect(summary().textContent).not.toContain("$0.000432")
  expect(summary().textContent).toContain("Some charges are not final")
})

test("receipt identities are available in collapsed details while incomplete costs stay visible", async () => {
  const host = mount(async () => report())
  await click(host)
  const receipt = [...host.querySelectorAll("li")].find((item) => item.textContent?.includes("Receipt receipt"))!
  const details = receipt.closest("details")!
  expect(details).not.toBeNull()
  expect(details.open).toBe(false)
  const warning = [...host.querySelectorAll('[role="status"]')].find((item) =>
    item.textContent?.includes("Some charges are not final"),
  )!
  expect(warning).toBeDefined()
  expect(warning.closest("details")).toBeNull()
  details.querySelector("summary")!.click()
  expect(details.open).toBe(true)
})

test("new session activity clears a checked cost and rejects an earlier in-flight total", async () => {
  const [version, setVersion] = solidjs.createSignal("1")
  const pending = Promise.withResolvers<SessionReceiptsResponses[200]>()
  let checks = 0
  const host = mount(() => (++checks === 1 ? Promise.resolve(report()) : pending.promise), version)
  await click(host)
  expect(host.querySelector("strong")!.textContent).toBe("USD 0.000001")
  setVersion("2")
  expect(host.querySelector("strong")!.textContent).toBe("Not checked")
  host.querySelector("button")!.click()
  setVersion("3")
  pending.resolve(report())
  await Bun.sleep(30)
  expect(host.querySelector("strong")!.textContent).toBe("Not checked")
})
