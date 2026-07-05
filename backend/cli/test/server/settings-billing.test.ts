import { test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { BillingSettingsRoutes } from "../../src/server/routes/settings/billing"

const file = path.join(Global.Path.config, "openscience.json")

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
