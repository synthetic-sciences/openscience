import { afterAll, beforeEach, expect, test } from "bun:test"

// The balance cache is module state keyed by funding context, so every test
// uses its own snapshot and nothing leaks between them.
const fixture = { balance: 0, gate: Promise.resolve(), requests: [] as string[] }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(input) {
    if (new URL(input.url).pathname !== "/api/cli/balance") return new Response(null, { status: 404 })
    fixture.requests.push(input.headers.get("authorization") ?? "")
    await fixture.gate
    return Response.json(
      { effective_balance_usd: fixture.balance },
      { headers: { "OpenScience-Funding-Protocol": "1", "OpenScience-Funding-Context": "personal" } },
    )
  },
})
const previousApiBase = process.env.OPENSCIENCE_API_BASE
process.env.OPENSCIENCE_API_BASE = server.url.toString()
const { OpenScience } = await import("../../src/openscience")

beforeEach(() => {
  fixture.balance = 0
  fixture.gate = Promise.resolve()
  fixture.requests = []
})
afterAll(() => {
  server.stop(true)
  if (previousApiBase === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previousApiBase
})

function funding(name: string) {
  return { api_key: `osk_fixture_${name}`, user_id: `user_${name}`, account: `user_${name}` }
}

/** Stall every balance response until the returned release runs. */
function hold() {
  const { promise, resolve } = Promise.withResolvers<void>()
  fixture.gate = promise
  return resolve
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => Promise<boolean> | boolean, what: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test("serves the last positive balance after invalidation and refreshes in the background", async () => {
  const snapshot = funding("positive")
  fixture.balance = 12.5
  expect(await OpenScience.getBalance(snapshot)).toBe(12.5)
  expect(fixture.requests).toHaveLength(1)

  OpenScience.invalidateBalance()
  fixture.balance = 7
  const release = hold()
  // The gateway is stalled, so a check that blocked on the fetch could not
  // resolve here: the prior value is served while the refresh runs.
  expect(await OpenScience.getBalance(snapshot)).toBe(12.5)
  // A second stale read joins the in-flight refresh instead of starting another.
  expect(await OpenScience.getBalance(snapshot)).toBe(12.5)
  await until(() => fixture.requests.length === 2, "the background refresh")
  expect(fixture.requests).toHaveLength(2)

  release()
  await until(async () => (await OpenScience.getBalance(snapshot)) === 7, "the refreshed balance")
  expect(fixture.requests).toHaveLength(2)
})

test("blocks on the fetch when the cached balance is not positive", async () => {
  const snapshot = funding("empty")
  expect(await OpenScience.getBalance(snapshot)).toBe(0)

  OpenScience.invalidateBalance()
  fixture.balance = 3
  expect(await OpenScience.getBalance(snapshot)).toBe(3)
  expect(fixture.requests).toHaveLength(2)
})

test("blocks on the fetch when nothing is cached", async () => {
  const snapshot = funding("fresh")
  fixture.balance = 5
  const release = hold()
  const pending = OpenScience.getBalance(snapshot)
  expect(await Promise.race([pending, sleep(50).then(() => "pending")])).toBe("pending")

  release()
  expect(await pending).toBe(5)
  expect(fixture.requests).toHaveLength(1)
})
