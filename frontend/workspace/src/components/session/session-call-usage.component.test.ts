import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { SessionReceiptsResponses, StepFinishPart } from "@synsci/sdk/v2/client"
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
  "/src/components/session/session-call-usage.tsx",
)) as typeof import("./session-call-usage")
const cleanups: Array<() => void> = []
const step = (id: string, usage?: StepFinishPart["usage"]): StepFinishPart => ({
  id,
  sessionID: "session",
  messageID: "message",
  type: "step-finish",
  reason: "stop",
  cost: 0,
  tokens: { input: 12, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  usage,
})
const usage = (cost?: NonNullable<StepFinishPart["usage"]>["cost"]): NonNullable<StepFinishPart["usage"]> => ({
  route: "byok",
  provider: "openrouter",
  model: "fixture-model",
  time: 1,
  reported: {
    input_tokens: 12,
    output_tokens: 2,
    total_tokens: 14,
    reasoning_tokens: null,
    cached_input_tokens: 0,
    cache_creation_input_tokens: null,
  },
  cost,
})
function mount(steps: StepFinishPart[], report?: SessionReceiptsResponses[200]) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => subject.SessionCallUsage({ steps, locale: "en-US", report }), host))
  return host
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("the compact call list retains counts and identities in collapsed details", () => {
  const host = mount([step("known", { ...usage(), call: "call-known", hold: "hold-known" })])
  const cells = [...host.querySelectorAll("tbody td")]
  expect(cells).toHaveLength(3)
  expect(cells[0].textContent).toContain("fixture-model")
  expect(cells[1].textContent).toContain("12 in")
  expect(cells[1].textContent).toContain("2 out")
  const details = cells[0].querySelector("details")!
  expect(details).not.toBeNull()
  expect(details.open).toBe(false)
  expect([...details.querySelectorAll("dd")].map((cell) => cell.textContent)).toEqual([
    "byok",
    "Unknown",
    "0",
    "Unknown",
    "call-known",
    "hold-known",
  ])
  details.querySelector("summary")!.click()
  expect(details.open).toBe(true)
})

const receiptReport = (): SessionReceiptsResponses[200] => ({
  rootSessionID: "session",
  sessions: 1,
  managedCalls: 1,
  missingCallIDs: 0,
  state: "available",
  chargedMicrousd: "362",
  calls: [{ call_id: "call-ace", state: "settled", receipt_id: "receipt-ace", hold_id: "hold-ace" }],
  receipts: [
    {
      receipt_id: "receipt-ace",
      hold_id: "hold-ace",
      charged_microusd: "362",
      settled_at: "2026-10-25T00:00:00Z",
      provider: "openrouter",
      model: "fixture-model",
    },
  ],
})
const managed = () =>
  step("ace", {
    ...usage({ source: "wallet_calculated", amountUSD: 0.99 }),
    route: "managed",
    call: "call-ace",
    hold: "hold-ace",
    reportedCostUSD: 0.88,
  })

test("the call cost comes only from a matching settled Wallet receipt", () => {
  const host = mount([managed()], receiptReport())
  expect(host.querySelector("tbody td:last-child")!.textContent).toBe("USD 0.000362")
  expect(host.textContent).not.toContain("$0.99")
  expect(host.textContent).not.toContain("$0.88")
  expect(host.textContent).not.toContain("Ace calculated")
  expect(host.textContent).not.toContain("Provider reported")
})

test("unchecked, pending and mismatched receipt costs are never shown as charges", () => {
  const unchecked = mount([managed()])
  expect(unchecked.querySelector("tbody td:last-child")!.textContent).toBe("Not checked")
  const report = receiptReport()
  const pending = mount([managed()], { ...report, calls: [{ ...report.calls[0]!, state: "pending" }] })
  expect(pending.querySelector("tbody td:last-child")!.textContent).toBe("Pending")
  const mismatched = mount([managed()], { ...report, receipts: [{ ...report.receipts[0]!, hold_id: "other-hold" }] })
  expect(mismatched.querySelector("tbody td:last-child")!.textContent).toBe("Unknown")
})
