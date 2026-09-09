import { expect, test } from "bun:test"
import { Onboarding } from "../../src/cli/onboard"
import { ONBOARDING_VERSION, patchPreferences } from "../../src/server/routes/settings/preferences"

test("the terminal setup only runs for a person at an interactive, non-restarted terminal", () => {
  expect(Onboarding.interactive({ isTTY: true, env: {} })).toBe(true)
  expect(Onboarding.interactive({ isTTY: false, env: {} })).toBe(false)
  expect(Onboarding.interactive({ isTTY: true, env: { CI: "1" } })).toBe(false)
  expect(Onboarding.interactive({ isTTY: true, env: { OPENSCIENCE_RESTARTED: "1" } })).toBe(false)
  expect(Onboarding.interactive({ isTTY: true, env: { OPENSCIENCE_SKIP_ONBOARDING: "1" } })).toBe(false)
})

test("every install sees the current setup revision once, including ones that finished the previous revision", async () => {
  await patchPreferences({ desktop_onboarding_version: 0 })
  expect(await Onboarding.pending()).toBe(true)

  await patchPreferences({ desktop_onboarding_version: ONBOARDING_VERSION - 1 })
  expect(await Onboarding.pending()).toBe(true)

  await patchPreferences({ desktop_onboarding_version: ONBOARDING_VERSION, desktop_onboarding_step: "done" })
  expect(await Onboarding.pending()).toBe(false)
})
