import { expect, test } from "bun:test"
import { Onboarding } from "../../src/cli/onboard"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"
import { ONBOARDING_VERSION, patchPreferences } from "../../src/server/routes/settings/preferences"

test("the terminal setup only runs for a person at an interactive, non-restarted terminal", () => {
  expect(Onboarding.interactive({ isTTY: true, env: {} })).toBe(true)
  expect(Onboarding.interactive({ isTTY: false, env: {} })).toBe(false)
  expect(Onboarding.interactive({ isTTY: true, env: { CI: "1" } })).toBe(false)
  expect(Onboarding.interactive({ isTTY: true, env: { OPENSCIENCE_RESTARTED: "1" } })).toBe(false)
  expect(Onboarding.interactive({ isTTY: true, env: { OPENSCIENCE_SKIP_ONBOARDING: "1" } })).toBe(false)
})

test("completed setup survives a revision change while an explicit reset requires setup", async () => {
  await patchPreferences({ desktop_onboarding_version: 0 })
  expect(await Onboarding.pending()).toBe(true)

  await patchPreferences({ desktop_onboarding_version: ONBOARDING_VERSION - 1 })
  expect(await Onboarding.pending()).toBe(false)

  await patchPreferences({ desktop_onboarding_version: ONBOARDING_VERSION, desktop_onboarding_step: "done" })
  expect(await Onboarding.pending()).toBe(false)

  await patchPreferences({ desktop_onboarding_version: 0, desktop_onboarding_step: "account" })
  expect(await Onboarding.pending()).toBe(true)
})

test("a Google key in the environment already counts as a connected model", async () => {
  await using tmp = await tmpdir({})
  const names = ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]
  const before = names.map((name) => process.env[name])
  for (const name of names) delete process.env[name]
  try {
    Provider.invalidate()
    expect(await Onboarding.modelProviders(tmp.path)).not.toContain("google")

    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "AIza-from-the-shell"
    Provider.invalidate()
    expect(await Onboarding.modelProviders(tmp.path)).toContain("google")
  } finally {
    names.forEach((name, index) => {
      if (before[index] === undefined) delete process.env[name]
      else process.env[name] = before[index]
    })
    Provider.invalidate()
  }
})
