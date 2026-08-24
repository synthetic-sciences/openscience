import { expect, test } from "bun:test"
import { Preferences, SettingsPreferencesRoutes } from "../../src/server/routes/settings/preferences"

test("advanced navigation is opt-in by default", () => {
  expect(Preferences.parse({})).toMatchObject({
    show_trace: false,
    atlas_enabled: false,
    delegation_enabled: true,
    delegation_specialist: null,
  })
})

test("legacy managed-compute budget preferences round-trip as a no-op", () => {
  const preferences = Preferences.parse({ extra_budget_usd: 250 })

  expect(preferences.extra_budget_usd).toBe(250)
})

test("composer preferences persist through the settings route", async () => {
  const app = SettingsPreferencesRoutes()
  const update = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      show_trace: true,
      atlas_enabled: false,
      extra_budget_usd: 75,
      delegation_enabled: false,
      delegation_specialist: "biology",
    }),
  })
  expect(update.status).toBe(200)
  expect((await update.json()) as Preferences).toMatchObject({
    show_trace: true,
    atlas_enabled: false,
    extra_budget_usd: 75,
    delegation_enabled: false,
    delegation_specialist: "biology",
  })

  const read = await app.request("/")
  expect(read.status).toBe(200)
  expect((await read.json()) as Preferences).toMatchObject({
    show_trace: true,
    atlas_enabled: false,
    extra_budget_usd: 75,
    delegation_enabled: false,
    delegation_specialist: "biology",
  })
})
