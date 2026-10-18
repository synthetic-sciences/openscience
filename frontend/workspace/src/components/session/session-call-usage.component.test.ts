import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { StepFinishPart } from "@synsci/sdk/v2/client"
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
function mount(steps: StepFinishPart[]) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => subject.SessionCallUsage({ steps, locale: "en-US" }), host))
  return host
}
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("per-call counts preserve known zero and show omitted dimensions as unknown", () => {
  const host = mount([step("known", usage())])
  const cells = [...host.querySelectorAll("tbody td")].map((cell) => cell.textContent)
  expect(cells.slice(1, 6)).toEqual(["12", "2", "Unknown", "0", "Unknown"])
  expect(cells[0]).toContain("byok")
  expect(cells[0]).toContain("fixture-model")
})

test("provider charges, estimates and calculated Ace costs have separate subtotals and call identities", () => {
  const host = mount([
    step("provider", usage({ source: "provider_response", amountUSD: 0.01 })),
    step("estimate", usage({ source: "catalog_estimate", amountUSD: 0.02 })),
    step("ace", {
      ...usage({ source: "wallet_calculated", amountUSD: 0.03 }),
      route: "managed",
      call: "call-ace",
      hold: "hold-ace",
    }),
  ])
  expect(host.textContent).toContain("Provider reported: $0.01")
  expect(host.textContent).toContain("Catalog estimate: $0.02")
  expect(host.textContent).toContain("Ace calculated · not a settled receipt: $0.03")
  expect(host.textContent).not.toContain("$0.06")
  expect(host.querySelector("tbody tr:last-child")?.textContent).toContain("call-ace")
  expect(host.querySelector("tbody tr:last-child")?.textContent).toContain("hold-ace")
})

test("historical subscription zeros and unknown costs are not presented as free calls", () => {
  const host = mount([
    step("subscription", { ...usage(), route: "chatgpt" }),
    step("unknown", usage({ source: "unknown", amountUSD: null })),
    step("legacy"),
  ])
  const rows = [...host.querySelectorAll("tbody tr")]
  expect(rows[0].textContent).toContain("Subscription covered")
  expect(rows[0].textContent).not.toContain("$0.00")
  expect(rows[1].textContent).not.toContain("$0.00")
  expect(rows[2].textContent).toContain("Historical accounting · basis unknown")
  expect(rows[2].querySelectorAll("td")[1].textContent).toBe("Unknown")
})
