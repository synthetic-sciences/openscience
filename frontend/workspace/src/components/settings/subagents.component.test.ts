import { createOpenScienceClient } from "@synsci/sdk/v2/client"
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
const subject = (await vite.ssrLoadModule("/src/components/settings/subagents.tsx")) as typeof import("./subagents")
const cleanups: Array<() => void> = []

const ready = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

async function mount(settings: Record<string, unknown> = {}, catalog?: Promise<void>) {
  const state = {
    settings,
    reject: false,
    readError: false,
    writes: [] as unknown[],
    requests: [] as { path: string; directory: string | null; project: string | null }[],
  }
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, PATCH, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      response.end(JSON.stringify(value))
    }
    if (request.method === "OPTIONS") return json(null, 204)
    const path = request.url ?? ""
    state.requests.push({
      path,
      directory: request.headers["x-openscience-directory"]?.toString() ?? null,
      project: request.headers["x-openscience-project"]?.toString() ?? null,
    })
    if (path === "/provider") {
      await catalog
      return json({
        connected: ["fixture"],
        default: {},
        all: [{ id: "fixture", name: "Fixture", models: { model: { id: "model", name: "Test model" } } }],
      })
    }
    if (path !== "/global/config") return json({}, 404)
    if (request.method === "PATCH") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
      state.writes.push(body)
      if (state.reject) return json({ message: "Disk is read-only" }, 503)
      const config = body as { subagents: Record<string, unknown> }
      state.settings = config.subagents
    }
    if (state.readError) return json({ message: "Config is unavailable" }, 503)
    return json({ subagents: state.settings })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener")
  const host = document.createElement("div")
  document.body.append(host)
  const client = createOpenScienceClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  const dispose = web.render(() => subject.Subagents({ services: { client } }), host)
  cleanups.push(() => {
    dispose()
    server.closeAllConnections()
    server.close()
  })
  const field = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
  const select = () => host.querySelector<HTMLSelectElement>("select")!
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!
  const fill = (name: string, value: string) => {
    field(name).value = value
    field(name).dispatchEvent(new Event("input", { bubbles: true }))
  }
  const save = () => button("Save subagent defaults").click()
  await ready(() => button("Save subagent defaults")?.disabled === false)
  return { state, host, field, select, fill, save, button }
}

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

test("setup inherits the calling model and never invents a paid allowance", async () => {
  const app = await mount()
  expect(app.select().selectedOptions[0]?.textContent).toBe("Same as calling agent")
  expect(app.field("Paid allowance (USD)").value).toBe("")
  expect(app.field("Subscription allowance (tokens)").value).toBe("")
  expect(app.field("Assignment deadline (minutes)").value).toBe("10")
  expect(app.state.writes).toEqual([])
  expect(app.host.textContent).toContain("model inference only")
  expect(app.host.textContent).toContain("main agent")
  expect(app.host.textContent).toContain("existing pools")
})

test("saving converts minutes and writes only user-global subagent defaults", async () => {
  const app = await mount()
  app.select().value = "fixture/model"
  app.select().dispatchEvent(new Event("change", { bubbles: true }))
  app.fill("Paid allowance (USD)", "2.5")
  app.fill("Subscription allowance (tokens)", "12000")
  app.fill("Assignment deadline (minutes)", "15")
  app.fill("USD increase amount", "1.25")
  app.fill("Token increase amount", "3000")
  app.save()
  await ready(() => app.host.querySelector('[role="status"]')?.textContent?.includes("Saved") === true)
  expect(app.state.writes).toEqual([
    {
      subagents: {
        model: "fixture/model",
        usd: 2.5,
        tokens: 12000,
        deadlineMs: 900000,
        usdIncrease: 1.25,
        tokenIncrease: 3000,
      },
    },
  ])
  expect(app.state.requests.every((request) => request.directory === null)).toBe(true)
  expect(app.state.requests.every((request) => request.project === null)).toBe(true)
  expect(app.state.requests.some((request) => request.path === "/config")).toBe(false)
})

test("a failed save keeps all edits available for an explicit retry", async () => {
  const app = await mount({ usd: 1, deadlineMs: 600000 })
  app.fill("Paid allowance (USD)", "3.75")
  app.fill("Subscription allowance (tokens)", "24000")
  app.state.reject = true
  app.save()
  await ready(() => app.host.querySelector('[role="alert"]') !== null)
  expect(app.field("Paid allowance (USD)").value).toBe("3.75")
  expect(app.field("Subscription allowance (tokens)").value).toBe("24000")
  expect(app.button("Save subagent defaults").disabled).toBe(false)
  expect(app.host.querySelector('[role="alert"]')?.textContent).toContain("could not be saved")
  app.state.reject = false
  app.save()
  await ready(() => app.host.querySelector('[role="status"]')?.textContent?.includes("Saved") === true)
  expect(app.state.settings).toEqual({ usd: 3.75, tokens: 24000, deadlineMs: 600000 })
})

test.each([
  ["Paid allowance (USD)", "0"],
  ["Paid allowance (USD)", "-1"],
  ["Subscription allowance (tokens)", "1.5"],
  ["Subscription allowance (tokens)", "9007199254740992"],
  ["Assignment deadline (minutes)", ""],
  ["Assignment deadline (minutes)", "0"],
  ["USD increase amount", "-2"],
  ["Token increase amount", "0.5"],
])("invalid %s (%s) prevents persistence and retains the edit", async (name, value) => {
  const app = await mount()
  app.fill(name, value)
  app.save()
  await ready(() => app.host.querySelector('[role="alert"]') !== null)
  expect(app.state.writes).toEqual([])
  expect(app.field(name).value).toBe(value)
})

test("clearing a saved model and allowance sends the full replacement defaults", async () => {
  const app = await mount({ model: "fixture/model", usd: 2, tokens: 1000, deadlineMs: 120000 })
  app.select().value = ""
  app.select().dispatchEvent(new Event("change", { bubbles: true }))
  app.fill("Paid allowance (USD)", "")
  app.save()
  await ready(() => app.state.writes.length === 1)
  expect(app.state.writes).toEqual([{ subagents: { tokens: 1000, deadlineMs: 120000 } }])
})

test("an unavailable saved model stays selected until the user changes it", async () => {
  const app = await mount({ model: "removed/old-model", tokens: 1000 })
  expect(app.select().value).toBe("removed/old-model")
  app.save()
  await ready(() => app.state.writes.length === 1)
  expect(app.state.writes).toEqual([{ subagents: { model: "removed/old-model", tokens: 1000, deadlineMs: 600000 } }])
})

test("a late model catalog cannot reset the saved model selection", async () => {
  const catalog = Promise.withResolvers<void>()
  const app = await mount({ model: "fixture/model", tokens: 1000 }, catalog.promise)
  expect(app.select().value).toBe("fixture/model")
  catalog.resolve()
  await ready(() => [...app.select().options].some((option) => option.textContent === "Test model · Fixture"))
  expect(app.select().value).toBe("fixture/model")
  app.save()
  await ready(() => app.state.writes.length === 1)
  expect(app.state.writes).toEqual([{ subagents: { model: "fixture/model", tokens: 1000, deadlineMs: 600000 } }])
})
