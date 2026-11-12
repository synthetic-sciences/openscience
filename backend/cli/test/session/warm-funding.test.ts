import { afterEach, expect, spyOn, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import { SessionProcessor } from "../../src/session/processor"
import * as AccessRoute from "../../src/session/access-route"

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

async function warmed(source: AccessRoute.CredentialSource) {
  spies.push(spyOn(AccessRoute, "resolveCredentialSource").mockResolvedValue(source))
  const warm = spyOn(OpenScience, "warmBalance").mockImplementation(() => {})
  spies.push(warm)
  SessionProcessor.warmFunding({ providerID: "synsci", modelID: "fixture" })
  await Bun.sleep(0)
  await Bun.sleep(0)
  return warm.mock.calls.length
}

test("a managed turn starts its balance read when the message is submitted", async () => {
  expect(await warmed("managed")).toBe(1)
})

test("a direct-key turn does not read the Ace balance", async () => {
  expect(await warmed("byok")).toBe(0)
})
