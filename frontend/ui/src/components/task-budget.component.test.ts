import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../workspace/test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../../workspace", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const reactive = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const data = (await vite.ssrLoadModule("@synsci/ui/context/data")) as typeof import("../context/data")
const subject = (await vite.ssrLoadModule("@synsci/ui/message-part")) as typeof import("./message-part")
const cleanups: Array<() => void> = []

function mount(metadata: Record<string, unknown>, options: { actions?: boolean } = {}) {
  const [state, setState] = reactive.createStore({ metadata })
  const host = document.createElement("div")
  document.body.append(host)
  const render = subject.ToolRegistry.render("task")!
  const opened: string[] = []
  const actions: { sessionID: string; taskSessionID: string }[] = []
  cleanups.push(
    web.render(
      () =>
        data.DataProvider({
          directory: "/research",
          data: {
            session: [{ id: "child", parentID: "parent", title: "Review controls" }] as never,
            session_status: {},
            session_diff: {},
            message: {},
            part: {},
          },
          onNavigateToSession: (sessionID) => opened.push(sessionID),
          renderTaskActions: options.actions
            ? (input) => {
                actions.push(input)
                const node = document.createElement("button")
                node.textContent = "Add and continue"
                return node
              }
            : undefined,
          get children() {
            return web.createComponent(render, {
              tool: "task",
              input: { description: "Review controls", subagent_type: "research" },
              get metadata() {
                return state.metadata
              },
              status: "completed",
            })
          },
        }),
      host,
    ),
  )
  return { host, setState, opened, actions }
}

const budget = (unit: "usd" | "tokens" = "usd") => ({
  unit,
  limit: unit === "usd" ? 1_000_000_000 : 1000,
  spent: unit === "usd" ? 750_000_000 : 750,
  pending: unit === "usd" ? 100_000_000 : 100,
  remaining: unit === "usd" ? 150_000_000 : 150,
  deadline: 1_800_000_000_000,
})

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
afterAll(() => vite.close())

test("the Task card shows the effective model, allowance use and brief findings before expansion", () => {
  const app = mount({
    sessionId: "child",
    outcome: "partial",
    model: { providerID: "provider", modelID: "worker" },
    budget: budget(),
    handoff: "Found two controls. More checks remain.",
  })
  expect(app.host.textContent).toContain("provider/worker")
  expect(app.host.textContent).toContain("$0.75 used")
  expect(app.host.textContent).toContain("$0.15 remaining")
  const findings = app.host.querySelector('[data-slot="delegation-findings"]')!
  expect(findings.textContent).toContain("Found two controls")
  expect(findings.closest("details")).toBeNull()
  const details = app.host.querySelector<HTMLDetailsElement>("details")!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain("$0.10 pending")
  expect(details.textContent).toContain("not a settled Wallet charge")
  app.host.querySelector<HTMLButtonElement>('[data-slot="delegation-summary"]')!.click()
  expect(app.opened).toEqual(["child"])
})

test("runtime limit metadata cannot be presented as a completed assignment despite a Complete report", () => {
  const app = mount({
    sessionId: "child",
    outcome: "completed",
    budget: { ...budget(), stopReason: "budget_limit" },
    handoff: "Outcome: Complete\nFound the reference, but verification is unfinished.",
  })
  expect(app.host.querySelector('[data-component="delegation-card"]')?.getAttribute("data-outcome")).toBe("partial")
  expect(app.host.textContent).toContain("Reached its limit")
  expect(app.host.querySelector('[data-slot="delegation-findings"]')?.textContent).not.toContain("Outcome: Complete")
  expect(app.host.textContent).toContain("Worker report")
})

test("budget wrap-up has a distinct reason from reaching the hard limit", () => {
  const app = mount({ sessionId: "child", outcome: "partial", budget: { ...budget(), stopReason: "budget_wrapup" } })
  expect(app.host.textContent).toContain("Budget wrap-up")
  expect(app.host.textContent).not.toContain("Reached its limit")
})

test("subscription use is shown only as tokens with no invented cash charge", () => {
  const app = mount({ sessionId: "child", outcome: "partial", budget: budget("tokens"), handoff: "Partial evidence." })
  expect(app.host.textContent).toContain("750 tokens used")
  expect(app.host.textContent).toContain("150 tokens remaining")
  expect(app.host.textContent).not.toContain("$")
  expect(app.host.textContent).toContain("not account quota or cash charges")
})

test("legacy task metadata never fabricates allowance amounts", () => {
  const app = mount({ sessionId: "child", outcome: "completed" })
  expect(app.host.querySelector('[data-slot="delegation-budget"]')).toBeNull()
  expect(app.host.querySelector("details")).toBeNull()
})

test("malformed budget metadata stays unknown instead of becoming zero usage", () => {
  const app = mount({ sessionId: "child", outcome: "partial", budget: { unit: "usd", spent: undefined } })
  expect(app.host.querySelector('[data-slot="delegation-budget"]')).toBeNull()
  expect(app.host.textContent).not.toContain("$0")
})

test("updated budget metadata refreshes the existing card", () => {
  const app = mount({ sessionId: "child", outcome: "partial", budget: budget("tokens") })
  app.setState("metadata", "budget", { ...budget("tokens"), spent: 900, remaining: 0, stopReason: "token_limit" })
  expect(app.host.textContent).toContain("900 tokens used")
  expect(app.host.textContent).toContain("Reached its limit")
  expect(app.host.textContent).not.toContain("750 tokens used")
})

test("a recorded limit reason remains authoritative when the amount snapshot is absent", () => {
  const app = mount({
    sessionId: "child",
    outcome: "completed",
    stopReason: "token_limit",
    handoff: "Outcome: Complete",
  })
  expect(app.host.querySelector('[data-component="delegation-card"]')?.getAttribute("data-outcome")).toBe("partial")
  expect(app.host.textContent).toContain("Reached its limit")
  expect(app.host.querySelector('[data-slot="delegation-budget"]')).toBeNull()
})

test("a worker stopped at its limit or deadline offers the host's continue actions on its card", () => {
  for (const stopReason of ["budget_limit", "token_limit", "deadline"]) {
    const app = mount(
      { sessionId: "child", outcome: "partial", budget: { ...budget(), stopReason } },
      { actions: true },
    )
    expect(app.host.querySelector('[data-slot="delegation-actions"]')?.textContent).toBe("Add and continue")
    expect(app.actions).toEqual([{ sessionID: "parent", taskSessionID: "child" }])
    cleanups.splice(0).forEach((cleanup) => cleanup())
  }
})

test("completed, cancelled and wrap-up workers show no continue actions on their card", () => {
  for (const metadata of [
    { sessionId: "child", outcome: "completed", budget: budget() },
    { sessionId: "child", outcome: "partial", budget: { ...budget(), stopReason: "cancelled" } },
    { sessionId: "child", outcome: "partial", budget: { ...budget(), stopReason: "budget_wrapup" } },
  ]) {
    const app = mount(metadata, { actions: true })
    expect(app.host.querySelector('[data-slot="delegation-actions"]')).toBeNull()
    expect(app.actions).toEqual([])
    cleanups.splice(0).forEach((cleanup) => cleanup())
  }
})
