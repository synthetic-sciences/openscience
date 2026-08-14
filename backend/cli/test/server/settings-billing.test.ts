import { test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Config } from "../../src/config/config"
import { BillingSettingsRoutes } from "../../src/server/routes/settings/billing"

const file = path.join(Global.Path.config, "openscience.json")

async function resetGlobalConfig() {
  // globalConfigFile() (config.ts) also considers .jsonc and config.json -
  // establish the candidate-file precondition before every test as well as
  // cleaning it afterwards, so a prior test cannot shadow the openscience.json
  // this file writes and reads directly. A deleted file alone does not
  // un-memoize Config.global, so reset that cache too.
  for (const name of ["openscience.jsonc", "openscience.json", "config.json"]) {
    await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
  }
  Config.global.reset()
}

beforeEach(resetGlobalConfig)
afterEach(resetGlobalConfig)

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
