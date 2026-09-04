import { afterAll, beforeEach, expect, test } from "bun:test"

// Every account surface reads the same status, entitlement and wallet
// endpoints. These tests count the outbound requests one real session
// produces while several surfaces ask at once.
const fixture = { requests: [] as string[], gate: Promise.resolve() }
const headers = { "OpenScience-Funding-Protocol": "1", "OpenScience-Funding-Context": "personal" }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    fixture.requests.push(pathname)
    await fixture.gate
    if (pathname === "/api/v1/auth/status") {
      return Response.json(
        {
          user: { user_id: "user_shared", email: "shared@example.com" },
          organizations: [],
          api_key: {},
          funding_context: { type: "personal" },
        },
        { headers },
      )
    }
    if (pathname === "/api/cli/access") {
      return Response.json(
        { cli_balance_cents: 1200, managed_supported: true, managed_unlocked: true, ace_enabled: false },
        { headers },
      )
    }
    if (pathname === "/api/v1/wallet") {
      return Response.json({ balance_cents: 1200, purchased_cents: 1200, lifetime_spent_cents: 0 }, { headers })
    }
    if (pathname === "/api/cli/balance") return Response.json({ effective_balance_usd: 12 }, { headers })
    return new Response(null, { status: 404 })
  },
})
const previousApiBase = process.env.OPENSCIENCE_API_BASE
process.env.OPENSCIENCE_API_BASE = server.url.toString()
const { OpenScience } = await import("../../src/openscience")

const session = { api_key: "thk_fixture_shared_status", user_id: "user_shared", workspace_locked: true }
const count = (pathname: string) => fixture.requests.filter((item) => item === pathname).length
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Stall every response until the returned release runs. */
function hold() {
  const { promise, resolve } = Promise.withResolvers<void>()
  fixture.gate = promise
  return resolve
}

beforeEach(async () => {
  fixture.requests = []
  fixture.gate = Promise.resolve()
  await OpenScience.saveSession(session)
})
afterAll(async () => {
  await OpenScience.clearSession()
  server.stop(true)
  if (previousApiBase === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previousApiBase
})

test("concurrent account surfaces share one in-flight status read", async () => {
  const release = hold()
  const pending = Promise.all([
    OpenScience.getReconciledFundingState(),
    OpenScience.getFundingContext(),
    OpenScience.getProfile(),
    OpenScience.getReconciledFundingState(),
  ])
  await until(() => count("/api/v1/auth/status") === 1, "the first status read")
  // Give every caller time to reach the outbound read before it settles.
  await sleep(50)
  release()
  const [state, context, profile] = await pending
  expect(count("/api/v1/auth/status")).toBe(1)
  expect(state?.snapshot.user_id).toBe("user_shared")
  expect(context.type).toBe("personal")
  expect(profile?.email).toBe("shared@example.com")
  // The flight is gone once settled, so a later caller reads fresh state.
  await OpenScience.getFundingContext()
  expect(count("/api/v1/auth/status")).toBe(2)
})

test("the reconciled state carries the profile so summaries do not read status twice", async () => {
  const state = await OpenScience.getReconciledFundingState()
  expect(state?.user).toEqual({ user_id: "user_shared", email: "shared@example.com" })
  expect(count("/api/v1/auth/status")).toBe(1)
})

test("concurrent billing-mode reads share one entitlement and one wallet request", async () => {
  const snapshot = (await OpenScience.getFundingSnapshot())!
  const release = hold()
  const pending = Promise.all([
    OpenScience.getBillingMode(snapshot),
    OpenScience.getBillingMode(snapshot),
    OpenScience.getCredits(snapshot),
  ])
  await until(() => count("/api/cli/access") === 1 && count("/api/v1/wallet") === 1, "the first reads")
  await sleep(50)
  release()
  const [first, second, credits] = await pending
  expect(count("/api/cli/access")).toBe(1)
  expect(count("/api/v1/wallet")).toBe(1)
  expect(count("/api/v1/auth/status")).toBe(0)
  expect(first?.managed_unlocked).toBe(true)
  expect(second?.access_verified).toBe(true)
  expect(credits?.balanceUsd).toBe(12)
})

test("a summary wallet read and a full wallet read stay separate flights", async () => {
  const snapshot = (await OpenScience.getFundingSnapshot())!
  const release = hold()
  const pending = Promise.all([
    OpenScience.getCredits(snapshot, { lifetimeSpent: false }),
    OpenScience.getCredits(snapshot),
    OpenScience.getCredits(snapshot, { lifetimeSpent: false }),
  ])
  await until(() => count("/api/v1/wallet") === 2, "both wallet reads")
  await sleep(50)
  release()
  await pending
  expect(count("/api/v1/wallet")).toBe(2)
})
