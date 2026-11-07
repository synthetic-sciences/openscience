import { afterAll, afterEach, expect, test } from "bun:test"
import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"
import { createProjectRequest } from "../../utils/openscience-fetch"

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
const reactive = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const subject = (await vite.ssrLoadModule(
  "/src/components/session/subagent-allowance.tsx",
)) as typeof import("./subagent-allowance")
const cleanups: Array<() => void> = []
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 150 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

function fixture(unit: "usd" | "tokens" = "usd") {
  return {
    version: 1,
    projectID: "project",
    rootSessionID: "parent",
    revision: 7,
    limits: { usd: 2_000_000_000, tokens: 4000 },
    available: { usd: 0, tokens: 0 },
    continuationCapacity: { child: { available: 0, ancestorLimited: false } },
    approvals: {},
    workers: {
      child: {
        sessionID: "child",
        parentSessionID: "parent",
        rootSessionID: "parent",
        assignmentID: "original-assignment",
        objective: "Review the controls",
        expectedOutput: "Findings and checks",
        model: { providerID: "provider", modelID: "worker-model" },
        route: unit === "usd" ? "byok" : "subscription",
        unit,
        limit: unit === "usd" ? 1_000_000_000 : 1000,
        spent: unit === "usd" ? 800_000_000 : 800,
        calls: { unknown: { amount: unit === "usd" ? 200_000_000 : 200, state: "pending" } },
        active: false,
        deadline: 1_800_000_000_000,
        stopReason: unit === "usd" ? "budget_limit" : "token_limit",
        outcome: "partial",
        reportReason: "budget_limit",
        handoff: "Found two controls. Verification remains unfinished.",
      },
    },
  }
}

async function mount(
  options: {
    unit?: "usd" | "tokens"
    available?: number
    increments?: boolean
    defaultsError?: boolean
    active?: boolean
    parent?: string
    cooperative?: boolean
    reason?: string
    enabled?: boolean
    ancestorLimited?: boolean
  } = {},
) {
  const state = {
    pool: fixture(options.unit),
    failIncrease: false,
    failContinue: false,
    stale: false,
    readError: false,
    pause: undefined as Promise<void> | undefined,
    readPause: undefined as Promise<void> | undefined,
    writes: [] as { path: string; body: Record<string, unknown>; project?: string; directory?: string }[],
    reads: [] as string[],
    approved: new Set<string>(),
  }
  state.pool.available[state.pool.workers.child.unit] = options.available ?? 0
  state.pool.continuationCapacity.child = {
    available: options.ancestorLimited ? 0 : (options.available ?? 0),
    ancestorLimited: options.ancestorLimited ?? false,
  }
  state.pool.workers.child.active = options.active ?? false
  state.pool.workers.child.parentSessionID = options.parent ?? "parent"
  if (options.reason) {
    state.pool.workers.child.stopReason = options.reason
    state.pool.workers.child.reportReason = options.reason
  }
  if (options.cooperative) {
    Reflect.deleteProperty(state.pool.workers.child, "stopReason")
    state.pool.workers.child.reportReason = "budget_wrapup"
  }
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-openscience-project, x-openscience-directory",
      })
      response.end(JSON.stringify(value))
    }
    if (request.method === "OPTIONS") return json(null, 204)
    const path = request.url ?? ""
    if (request.method === "GET") {
      state.reads.push(path)
      if (state.readError) return json({ message: "Allowance unavailable" }, 503)
      const pool = structuredClone(state.pool)
      await state.readPause
      return json(
        options.enabled === false
          ? { ...pool, enabled: false, limits: { usd: 0, tokens: 0 }, available: { usd: 0, tokens: 0 }, workers: {} }
          : options.enabled === true
            ? { ...pool, enabled: true }
            : pool,
      )
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    state.writes.push({
      path,
      body,
      project: request.headers["x-openscience-project"]?.toString(),
      directory: request.headers["x-openscience-directory"]?.toString(),
    })
    await state.pause
    if (path.endsWith("/increase")) {
      if (state.stale) {
        state.stale = false
        state.pool.revision++
        state.pool.limits.usd = 3_000_000_000
        return json({ message: "Allowance revision changed" }, 409)
      }
      const key = String(body.key)
      if (!state.approved.has(key)) {
        state.approved.add(key)
        const unit = body.unit === "usd" ? "usd" : "tokens"
        state.pool.limits[unit] += Number(body.amount) * (unit === "usd" ? 1e9 : 1)
        state.pool.revision++
      }
      if (state.failIncrease) return json({ message: "Response unavailable" }, 503)
      return json(state.pool)
    }
    if (state.failContinue) return json({ message: "Continuation unavailable" }, 503)
    return json({ sessionID: "child", callID: "new-task-call" }, 202)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener")
  const [scope, setScope] = reactive.createStore({ sessionID: "parent", projectID: "project", directory: "/research" })
  const request = createProjectRequest({
    baseUrl: () => `http://127.0.0.1:${address.port}`,
    projectID: () => scope.projectID,
    directory: () => scope.directory,
    fetch: () => fetch,
  })
  const listeners = new Set<(sessionID: string) => void>()
  const emit = (sessionID: string) => listeners.forEach((listener) => listener(sessionID))
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      subject.SubagentAllowance({
        get sessionID() {
          return scope.sessionID
        },
        services: {
          request,
          get scope() {
            return `${scope.projectID}:${scope.directory}`
          },
          defaults: async () => {
            if (options.defaultsError) throw new Error("Defaults unavailable")
            return options.increments === false ? {} : { usdIncrease: 1.25, tokenIncrease: 2000 }
          },
          events: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      }),
    host,
  )
  cleanups.push(() => {
    dispose()
    server.closeAllConnections()
    server.close()
  })
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text))!
  const load = async () => {
    button("Load subagent allowance").click()
    await ready(
      () =>
        host.textContent?.includes(
          options.enabled === false ? "Bounded runs are off for this conversation" : "Review the controls",
        ) === true,
    )
  }
  return { state, host, button, load, setScope, emit, listeners }
}

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

test("legacy snapshots without an enabled field retain bounded allowance controls", async () => {
  const app = await mount()
  expect(app.state.reads).toEqual([])
  await app.load()
  expect(app.host.textContent).toContain("USD 2")
  expect(app.host.textContent).toContain("USD 0.8")
  expect(app.host.textContent).toContain("USD 0.2")
  expect(app.host.textContent).toContain("main agent")
  expect(app.host.textContent).toContain("USD limit reached")
  expect(app.host.textContent).toContain("Verification remains unfinished")
  expect(app.host.querySelector("details")?.open).toBe(false)
  expect(app.host.textContent).not.toContain("Deducted from Wallet")
  expect(app.state.writes).toEqual([])
  expect(app.button("Increase limit by")).toBeDefined()
})

test("deadline wrap-up has a clear reason without offering a budget increase", async () => {
  const app = await mount({ reason: "deadline_wrapup", available: 1_000_000_000 })
  await app.load()
  expect(app.host.textContent).toContain("Deadline wrap-up")
  expect(app.host.textContent).not.toContain("deadline_wrapup")
  expect(app.button("Increase limit by")).toBeUndefined()
  expect(app.button("Continue with remaining allowance")).toBeUndefined()
  expect(app.state.writes).toEqual([])
})

test("a conversation with bounded runs off has no approval or continuation controls", async () => {
  const app = await mount({ enabled: false })
  await app.load()
  expect(app.host.textContent).toContain("Bounded runs are off for this conversation")
  expect(app.host.textContent).toContain("start a new conversation")
  expect(app.host.textContent).not.toContain("approved")
  expect(app.host.querySelector("details")).toBeNull()
  expect(app.button("Increase limit by")).toBeUndefined()
  expect(app.button("Continue")).toBeUndefined()
  expect(app.button("Stop here")).toBeUndefined()
  app.button("Refresh subagent allowance").click()
  await ready(() => app.state.reads.length === 2)
  expect(app.state.writes).toEqual([])
})

test("an explicit increase shows old and new totals and continues the same child with scoped requests", async () => {
  const app = await mount({ enabled: true })
  await app.load()
  expect(app.host.textContent).toContain("USD 2 → USD 3.25")
  app.button("Increase limit by USD 1.25 and continue").click()
  await ready(() => app.host.textContent?.includes("Continuation queued") === true)
  expect(app.state.writes.map((write) => write.path)).toEqual([
    "/session/parent/subagents/budget/increase",
    "/session/parent/subagents/child/continue",
  ])
  expect(app.state.writes[0]!.body).toMatchObject({ unit: "usd", amount: 1.25, revision: 7 })
  expect(String(app.state.writes[0]!.body.key)).toMatch(/^[0-9a-f-]{36}$/)
  expect(app.state.writes.every((write) => write.project === "project" && write.directory === "/research")).toBe(true)
  expect(app.state.pool.limits.usd).toBe(3_250_000_000)
})

test("subscription increases use actual tokens and no dollar conversion", async () => {
  const app = await mount({ unit: "tokens" })
  await app.load()
  app.button("Increase limit by 2,000 tokens and continue").click()
  await ready(() => app.state.writes.length === 2)
  expect(app.state.writes[0]!.body).toMatchObject({ unit: "tokens", amount: 2000, revision: 7 })
  const worker = app.host.querySelector("details")!
  expect(worker.textContent).toContain("800 tokens")
  expect(worker.textContent).not.toContain("USD")
})

test("retrying an uncertain increase reuses its approval key and original revision", async () => {
  const app = await mount()
  await app.load()
  app.state.failIncrease = true
  app.button("Increase limit by").click()
  await ready(() => app.host.querySelector('[role="alert"]') !== null)
  expect(app.state.writes).toHaveLength(1)
  app.state.failIncrease = false
  app.button("Increase limit by").click()
  await ready(() => app.host.textContent?.includes("Continuation queued") === true)
  expect(app.state.writes[1]!.body).toEqual(app.state.writes[0]!.body)
  expect(app.state.pool.limits.usd).toBe(3_250_000_000)
  expect(app.state.writes).toHaveLength(3)
})

test("a failed continuation retries only continuation with the same idempotency key", async () => {
  const app = await mount()
  await app.load()
  app.state.failContinue = true
  app.button("Increase limit by").click()
  await ready(() => app.host.querySelector('[role="alert"]') !== null)
  app.state.failContinue = false
  app.button("Retry continuing").click()
  await ready(() => app.host.textContent?.includes("Continuation queued") === true)
  expect(app.state.writes.filter((write) => write.path.endsWith("/increase"))).toHaveLength(1)
  expect(app.state.writes[2]!.body).toEqual(app.state.writes[1]!.body)
})

test("a revision conflict refreshes totals and requires another explicit approval", async () => {
  const app = await mount()
  await app.load()
  app.state.stale = true
  app.button("Increase limit by").click()
  await ready(() => app.host.textContent?.includes("Review the refreshed totals") === true)
  expect(app.host.textContent).toContain("USD 3 → USD 4.25")
  expect(app.state.writes).toHaveLength(1)
  app.button("Increase limit by").click()
  await ready(() => app.state.writes.length === 3)
  expect(app.state.writes[1]!.body.revision).toBe(8)
  expect(app.state.writes[1]!.body.key).not.toBe(app.state.writes[0]!.body.key)
})

test("a continuation that ended without starting a new assignment releases the queued state", async () => {
  const app = await mount({ available: 1_000_000_000, increments: false })
  await app.load()
  app.button("Continue with remaining allowance").click()
  await ready(() => app.host.textContent?.includes("Continuation queued") === true)
  const key = String(app.state.writes[0]!.body.key)
  Object.assign(app.state.pool, { continuations: { [key]: { childID: "child", completed: true } } })
  app.button("Refresh subagent allowance").click()
  await ready(() => app.host.textContent?.includes("Continuation queued") === false)
  expect(app.button("Continue with remaining allowance")).toBeDefined()
})

test("a loaded panel follows status changes of its conversation and workers without a manual refresh", async () => {
  const app = await mount({ available: 1_000_000_000, increments: false })
  app.emit("parent")
  await Bun.sleep(400)
  expect(app.state.reads).toHaveLength(0)
  await app.load()
  app.button("Continue with remaining allowance").click()
  await ready(() => app.host.textContent?.includes("Continuation queued") === true)
  const reads = app.state.reads.length
  app.emit("unrelated")
  await Bun.sleep(400)
  expect(app.state.reads).toHaveLength(reads)
  Object.assign(app.state.pool.workers.child, { assignmentID: "continued", active: true })
  Reflect.deleteProperty(app.state.pool.workers.child, "stopReason")
  app.emit("child")
  await ready(() => app.host.textContent?.includes("Review the controls · Running") === true)
  expect(app.host.textContent).not.toContain("Continuation queued")
  Object.assign(app.state.pool.workers.child, { active: false, stopReason: "budget_limit", spent: 1_000_000_000 })
  app.emit("parent")
  await ready(() => app.host.textContent?.includes("USD 1 used of USD 1") === true)
  expect(app.button("Continue with remaining allowance")).toBeDefined()
})

test("status events are not followed after the panel unmounts", async () => {
  const app = await mount()
  await app.load()
  expect(app.listeners.size).toBe(1)
  cleanups.splice(0).forEach((cleanup) => cleanup())
  expect(app.listeners.size).toBe(0)
})

test("remaining approved allowance continues the child without any increase", async () => {
  const app = await mount({ available: 1_000_000_000, increments: false })
  await app.load()
  expect(app.button("Continue with remaining allowance")).toBeDefined()
  app.button("Continue with remaining allowance").click()
  await ready(() => app.state.writes.length === 1)
  expect(app.state.writes[0]!.path).toBe("/session/parent/subagents/child/continue")
})

test.each(["usd", "tokens"] as const)(
  "a small positive %s balance keeps both continuation and explicit increase available",
  async (unit) => {
    const app = await mount({ unit, available: 100 })
    await app.load()
    expect(app.button("Continue with remaining allowance") !== undefined).toBe(true)
    expect(app.button("Increase limit by") !== undefined).toBe(true)
    const actions = [...app.host.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) =>
        button.textContent?.includes("Continue with remaining allowance") ||
        button.textContent?.includes("Increase limit by"),
    )
    expect(actions[0]!.textContent).toContain("Continue with remaining allowance")
    expect(app.state.writes).toEqual([])
    app.button("Increase limit by").click()
    await ready(() => app.host.textContent?.includes("Continuation queued") === true)
    expect(app.state.writes.map((write) => write.path)).toEqual([
      "/session/parent/subagents/budget/increase",
      "/session/parent/subagents/child/continue",
    ])
    expect(app.state.writes[0]!.body).toMatchObject({ unit, amount: unit === "usd" ? 1.25 : 2000, revision: 7 })
  },
)

test("choosing remaining allowance never increases the limit even when an increment is configured", async () => {
  const app = await mount({ unit: "tokens", available: 100 })
  await app.load()
  app.button("Continue with remaining allowance").click()
  await ready(() => app.host.textContent?.includes("Continuation queued") === true)
  expect(app.state.writes.map((write) => write.path)).toEqual(["/session/parent/subagents/child/continue"])
  expect(app.state.pool.limits.tokens).toBe(4000)
})

test("Stop here retains the report and performs no write or continuation", async () => {
  const app = await mount()
  await app.load()
  app.button("Stop here").click()
  expect(app.state.writes).toEqual([])
  expect(app.host.textContent).toContain("partial results are kept")
  expect(app.host.textContent).toContain("Found two controls")
  expect(app.button("Increase limit by")).toBeUndefined()
})

test("failed defaults loads and active children never expose an increase action", async () => {
  const app = await mount({ defaultsError: true })
  await app.load()
  expect(app.button("Increase limit by")).toBeUndefined()
  expect(app.host.textContent).toContain("Configure an increase amount")
  const active = await mount({ active: true })
  await active.load()
  expect(active.button("Increase limit by")).toBeUndefined()
  expect(active.button("Continue with remaining allowance")).toBeUndefined()
})

test("duplicate clicks cannot submit twice while an increase is pending", async () => {
  const app = await mount()
  await app.load()
  const pause = Promise.withResolvers<void>()
  app.state.pause = pause.promise
  const button = app.button("Increase limit by")
  button.click()
  button.click()
  await ready(() => app.state.writes.length === 1)
  expect(button.disabled).toBe(true)
  pause.resolve()
  await ready(() => app.state.writes.length === 2)
})

test("session and project changes discard stale allowance responses", async () => {
  const app = await mount()
  const pause = Promise.withResolvers<void>()
  app.state.readPause = pause.promise
  app.button("Load subagent allowance").click()
  await ready(() => app.state.reads.length === 1)
  app.setScope({ sessionID: "other", projectID: "other-project", directory: "/other" })
  pause.resolve()
  await Bun.sleep(30)
  expect(app.host.textContent).not.toContain("Review the controls")
  expect(app.host.textContent).not.toContain("USD 2")
  expect(app.button("Load subagent allowance").disabled).toBe(false)
})

test("a root conversation cannot directly continue a nested subagent", async () => {
  const app = await mount({ parent: "immediate-parent" })
  await app.load()
  expect(app.button("Increase limit by")).toBeUndefined()
  expect(app.button("Continue with remaining allowance")).toBeUndefined()
  expect(app.host.textContent).toContain("immediate-parent")
  expect(app.state.writes).toEqual([])
})

test("navigation after approval dispatch cannot continue a child in the new scope", async () => {
  const app = await mount()
  await app.load()
  const pause = Promise.withResolvers<void>()
  app.state.pause = pause.promise
  app.button("Increase limit by").click()
  await ready(() => app.state.writes.length === 1)
  app.setScope({ sessionID: "other", projectID: "other-project", directory: "/other" })
  pause.resolve()
  await Bun.sleep(30)
  expect(app.state.writes).toHaveLength(1)
  expect(app.host.textContent).not.toContain("Continuation queued")
  expect(app.host.textContent).not.toContain("Review the controls")
})

test("a failed conflict refresh cannot leave stale totals available for another approval", async () => {
  const app = await mount()
  await app.load()
  app.state.stale = true
  app.state.readError = true
  app.button("Increase limit by").click()
  await ready(() => app.state.reads.length === 2)
  await ready(() => app.host.querySelector('[role="alert"]') !== null)
  expect(app.host.textContent).toContain("could not be loaded")
  expect(app.host.querySelector("button[disabled]")).toBeNull()
  expect(app.button("Increase limit by") === undefined).toBe(true)
  expect(app.state.writes).toHaveLength(1)
})

test("a cooperative partial handoff can continue with the remaining allowance", async () => {
  const app = await mount({ available: 1000000000, cooperative: true, increments: false })
  await app.load()
  expect(app.button("Continue with remaining allowance")).toBeDefined()
  app.button("Continue with remaining allowance").click()
  await ready(() => app.state.writes.length === 1)
  expect(app.state.writes[0]!.path).toBe("/session/parent/subagents/child/continue")
})

test.each(["usd", "tokens"] as const)("missing %s increase config uses the suggested amount", async (unit) => {
  const app = await mount({ unit, increments: false })
  await app.load()
  expect(app.button("Increase limit by")).toBeDefined()
  app.button("Increase limit by").click()
  await ready(() => app.state.writes.length === 2)
  expect(app.state.writes[0]!.body.amount).toBe(unit === "usd" ? 1 : 250000)
})

test("nested workers with exhausted parent grants do not offer ineffective root increases", async () => {
  const app = await mount({ unit: "tokens", available: 50, parent: "middle", ancestorLimited: true })
  app.setScope("sessionID", "middle")
  await app.load()
  expect(app.host.textContent).toContain("Continue the parent task first to allocate allowance to this subagent.")
  expect(app.button("Continue with remaining allowance")).toBeUndefined()
  expect(app.button("Increase limit by")).toBeUndefined()
  expect(app.state.writes).toHaveLength(0)
})
