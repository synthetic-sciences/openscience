import { afterEach, expect, spyOn, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import { SessionProcessor } from "../../src/session/processor"
import * as AccessRoute from "../../src/session/access-route"

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

// Ace decides every managed call against the real Wallet (holds, reload,
// limits), so the turn path never reads or waits on the client's balance copy.
async function balanceReads(source: AccessRoute.CredentialSource) {
  spies.push(spyOn(AccessRoute, "resolveCredentialSource").mockResolvedValue(source))
  const warm = spyOn(OpenScience, "warmBalance").mockImplementation(() => {})
  const read = spyOn(OpenScience, "getBalance").mockResolvedValue(0)
  spies.push(warm, read)
  SessionProcessor.warmFunding({ providerID: "synsci", modelID: "fixture" })
  await Bun.sleep(0)
  await Bun.sleep(0)
  return warm.mock.calls.length + read.mock.calls.length
}

test("submitting a managed message does not read the Ace balance", async () => {
  expect(await balanceReads("managed")).toBe(0)
})

test("submitting a direct-key message does not read the Ace balance", async () => {
  expect(await balanceReads("byok")).toBe(0)
})

test("the managed pre-flight never consults the client's balance, even when it reads zero", async () => {
  const read = spyOn(OpenScience, "getBalance").mockResolvedValue(0)
  spies.push(read)
  expect(() => SessionProcessor.managedPreflight({ api_key: "osk_fixture" } as never)).not.toThrow()
  expect(read).not.toHaveBeenCalled()
})

test("a managed turn without a funding snapshot still pauses (a sign-in problem, not a balance one)", () => {
  expect(() => SessionProcessor.managedPreflight(undefined)).toThrow("could not snapshot the connected funding account")
})
