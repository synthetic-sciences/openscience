import { expect, test } from "bun:test"
import { Preferences, SettingsPreferencesRoutes } from "../../src/server/routes/settings/preferences"

test("trace navigation is opt-in by default", () => {
  expect(Preferences.parse({}).show_trace).toBe(false)
})

test("trace navigation preference persists through the settings route", async () => {
  const app = SettingsPreferencesRoutes()
  const update = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ show_trace: true }),
  })
  expect(update.status).toBe(200)
  expect(((await update.json()) as Preferences).show_trace).toBe(true)

  const read = await app.request("/")
  expect(read.status).toBe(200)
  expect(((await read.json()) as Preferences).show_trace).toBe(true)
})
