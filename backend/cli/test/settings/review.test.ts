import { afterEach, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
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

test("mounted reviewer settings retain their published GET and PUT contract", async () => {
  const fetch = Server.internalFetch()
  await ReviewSettings.set({ auto: false, model: null })

  const initial = await fetch("http://openscience.internal/settings/review")
  expect(initial.status).toBe(200)
  expect(await initial.json()).toEqual({ auto: false, model: null })

  const updated = await fetch("http://openscience.internal/settings/review", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auto: true, model: { providerID: "test", modelID: "reviewer" } }),
  })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toEqual({
    auto: true,
    model: { providerID: "test", modelID: "reviewer" },
  })
})
