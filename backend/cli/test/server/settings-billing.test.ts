import { test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Config } from "../../src/config/config"
import { BillingSettingsRoutes } from "../../src/server/routes/settings/billing"

const file = path.join(Global.Path.config, "openscience.json")

// Config.global is a lazy, in-process cache invalidated only by
// Config.updateGlobal()/replaceGlobal() calling .reset() — a bare GET never
// resets it. Force a fresh disk read before every test so a read-only test
// can never observe a previous test's in-memory state after that test's
// afterEach has already deleted the file out from under it.
beforeEach(() => {
  Config.global.reset()
})

afterEach(async () => {
  await fs.rm(file, { force: true }).catch(() => {})
})

test("PUT persists the toggle without baking resolved secrets into the config file", async () => {
  process.env["SPEND_TOGGLE_TEST_KEY"] = "sk-live-super-secret-123"
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({ provider: { openrouter: { options: { apiKey: "{env:SPEND_TOGGLE_TEST_KEY}" } } } }, null, 2),
  )

  const res = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ llm: "byok" }),
  })
  expect(res.status).toBe(200)
  const state = await res.json()
  expect(state.llm).toBe("byok")

  const text = await Bun.file(file).text()
  expect(text).toContain("{env:SPEND_TOGGLE_TEST_KEY}")
  expect(text).not.toContain("sk-live-super-secret-123")

  const written = JSON.parse(text)
  expect(written.billing).toEqual({ llm: "byok" })
})

test("PUT llm null sets the toggle back to auto", async () => {
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Bun.write(file, JSON.stringify({ billing: { llm: "managed" } }, null, 2))

  const res = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ llm: null }),
  })
  expect(res.status).toBe(200)
  const state = await res.json()
  expect(state.llm).toBeNull()

  const written = JSON.parse(await Bun.file(file).text())
  expect(written.billing.llm).toBeNull()
})

test("GET compute with no config file round-trips as unset (null), not byok", async () => {
  // No config file at all — the state readState() must report for a brand
  // new user, who has never touched Settings > Spend > Compute. Coercing
  // this to "byok" makes the UI show BYOK as active when nothing was chosen,
  // and is exactly the bug that let a user narrow themselves into "none" by
  // clicking BYOK to "undo" a state they never set.
  const res = await BillingSettingsRoutes().request("/")
  expect(res.status).toBe(200)
  const state = await res.json()
  expect(state.compute).toBeNull()
})

test("PUT compute null sets the toggle back to auto", async () => {
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Bun.write(file, JSON.stringify({ billing: { compute: "byok" } }, null, 2))

  const res = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compute: null }),
  })
  expect(res.status).toBe(200)
  const state = await res.json()
  expect(state.compute).toBeNull()

  const written = JSON.parse(await Bun.file(file).text())
  expect(written.billing.compute).toBeNull()
})
