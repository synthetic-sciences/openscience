import { afterEach, expect, test } from "bun:test"
import { ReviewSettings } from "../../src/settings/review"

afterEach(() => ReviewSettings.set({ auto: false, model: null }))

test("reviewer settings default to the session model", async () => {
  expect(ReviewSettings.State.parse({ auto: false })).toEqual({ auto: false, model: null })
})

test("reviewer settings preserve an independent model selection", async () => {
  const selected = {
    auto: true,
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
  }
  await ReviewSettings.set(selected)
  expect(await ReviewSettings.get()).toEqual(selected)
})
