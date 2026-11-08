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
function mount(load: () => Promise<SessionReceiptsResponses[200]>) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.TaskReceipts({
          sessionID: "session",
          load,
        }),
      host,
    ),
  )
  return host
}
const settle = () => Bun.sleep(30)
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("settled receipts load on open and preserve sub-cent amounts alongside pending workers", async () => {
  let checks = 0
  const host = mount(async () => {
    checks++
    return report()
  })
  await settle()
  expect(checks).toBe(1)
  expect(host.querySelector("strong")!.textContent).toBe("$0.000001")
  expect(host.textContent).toContain("Includes workers")
  expect(host.textContent).toContain("worker-model")
  expect(host.textContent).toContain("Some charges are not final (1 pending)")
})

test("no receipts and unknown calls are never displayed as a free task", async () => {
  const host = mount(async () => ({ ...report(), chargedMicrousd: "0", receipts: [], missingCallIDs: 1, calls: [] }))
  await settle()
  expect(host.textContent).toContain("No settled receipts yet")
  expect(host.textContent).toContain("(1 missing)")
  expect(host.textContent).not.toContain("$0.00")
  expect(host.querySelector("strong")!.textContent).toBe("Unknown")
})

test("account changes clear receipts and discard a late response from the previous account", async () => {
  const pending = Promise.withResolvers<SessionReceiptsResponses[200]>()
  let checks = 0
  const host = mount(() => (++checks === 1 ? pending.promise : new Promise(() => {})))
  await settle()
  window.dispatchEvent(new Event("openscience:account-changed"))
  pending.resolve(report())
  await settle()
  expect(checks).toBe(2)
  expect(host.textContent).not.toContain("$0.000001")
  expect(host.textContent).not.toContain("worker-model")
  expect(host.querySelector("strong")!.textContent).toBe("Checking…")
})

test("an older receipt server remains explicitly unavailable", async () => {
  const host = mount(async () => ({
    ...report(),
    state: "unavailable",
    reason: "unsupported",
    receipts: [],
    calls: [],
  }))
  await settle()
  expect(host.textContent).toContain("does not support per-call receipts yet")
  expect(host.querySelector('[aria-label="Wallet cost by model"]')).toBeNull()
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
  await settle()
  expect(host.querySelector("strong")!.textContent).toBe("$0.00")
  expect(host.textContent).not.toContain("No settled receipts yet")
  expect(host.textContent).not.toContain("Some charges are not final")
})

test("the cost summary shows a readable Wallet total with the exact amount on hover", async () => {
  const host = mount(async () => ({ ...report(), chargedMicrousd: "238208" }))
  const summary = () => host.querySelector('[aria-label="Cost so far"]')!
  expect(summary().textContent).toContain("Checking…")
  await settle()
  const total = host.querySelector("strong")!
  expect(total.textContent).toBe("$0.24")
  expect(total.getAttribute("title")).toBe("USD 0.238208")
  expect(summary().textContent).not.toContain("Estimated")
  expect(summary().textContent).toContain("Deducted from Wallet")
  expect(summary().textContent).toContain("Some charges are not final")
})

test("a failed check offers a retry that loads the total", async () => {
  let checks = 0
  const host = mount(async () => {
    if (++checks === 1) throw new Error("offline")
    return report()
  })
  await settle()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Could not check settled charges")
  host.querySelector("button")!.click()
  await settle()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector("strong")!.textContent).toBe("$0.000001")
})

test("settled charges for the task and its workers are grouped by model, largest first", async () => {
  const fixture = report()
  const receipt = (id: string, model: string, micro: string) => ({
    ...fixture.receipts[0]!,
    receipt_id: id,
    model,
    charged_microusd: micro,
  })
  const host = mount(async () => ({
    ...fixture,
    chargedMicrousd: "238208",
    calls: [fixture.calls[0]!],
    receipts: [
      receipt("a", "anthropic/claude-haiku-4.5", "657"),
      receipt("b", "anthropic/claude-opus-5.5", "200000"),
      receipt("c", "anthropic/claude-haiku-4.5", "644"),
      receipt("d", "anthropic/claude-opus-5.5", "36907"),
    ],
  }))
  await settle()
  const rows = [...host.querySelectorAll('[aria-label="Wallet cost by model"] li')].map((row) => row.textContent)
  expect(rows).toEqual(["anthropic/claude-opus-5.52 calls$0.24", "anthropic/claude-haiku-4.52 calls$0.0013"])
  expect(host.querySelector("details")).toBeNull()
  expect(host.textContent).not.toContain("Some charges are not final")
})

test("the Wallet is asked once per open and shows when it was checked", async () => {
  let checks = 0
  const host = mount(async () => {
    checks++
    return report()
  })
  await settle()
  await settle()
  expect(checks).toBe(1)
  expect(host.textContent).toContain("Checked ")
})

test("closing and reopening the panel checks again", async () => {
  let checks = 0
  const load = async () => ({ ...report(), chargedMicrousd: String(++checks * 10000) })
  mount(load)
  await settle()
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  const host = mount(load)
  await settle()
  expect(checks).toBe(2)
  expect(host.querySelector("strong")!.textContent).toBe("$0.02")
})
