import { afterAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// A managed turn is charged by the gateway a moment after its stream ends.
// These tests drive the settlement hook the processor calls per step against
// an isolated loopback account service and watch what it announces.
const fixture = {
  requests: [] as string[],
  fail: new Set<string>(),
  wallet: 1200,
  available: 1100,
}
const headers = { "OpenScience-Funding-Protocol": "1", "OpenScience-Funding-Context": "personal" }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    fixture.requests.push(pathname)
    if (fixture.fail.has(pathname)) return new Response(null, { status: 503 })
    if (pathname === "/api/v1/auth/status") {
      return Response.json(
        { user: { user_id: "user_spend" }, organizations: [], api_key: {}, funding_context: { type: "personal" } },
        { headers },
      )
    }
    if (pathname === "/api/cli/access") {
      return Response.json(
        { cli_balance_cents: fixture.wallet, managed_supported: true, managed_unlocked: true, ace_enabled: true },
        { headers },
      )
    }
    if (pathname === "/api/v1/wallet") {
      return Response.json(
        {
          balance_cents: fixture.wallet,
          available_cents: fixture.available,
          purchased_cents: fixture.wallet,
          lifetime_spent_cents: 0,
        },
        { headers },
      )
    }
    if (pathname === "/api/cli/balance")
      return Response.json({ effective_balance_usd: fixture.wallet / 100 }, { headers })
    return new Response(null, { status: 404 })
  },
})
const previousApiBase = process.env.OPENSCIENCE_API_BASE
const previousDeadline = process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS
process.env.OPENSCIENCE_API_BASE = server.url.toString()
process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = "15000"
const { OpenScience } = await import("../../src/openscience")
const { GlobalBus } = await import("../../src/bus/global")
const { Global } = await import("../../src/global")

const session = { api_key: "thk_fixture_spend", user_id: "user_spend", workspace_locked: true }
const snapshotFile = path.join(Global.Path.data, "openscience-account-snapshot.json")
const count = (pathname: string) => fixture.requests.filter((item) => item === pathname).length
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

type Update = { refreshed_at: number; error?: string }
const updates: Update[] = []
const listener = (event: { payload: { type: string; properties: Update } }) => {
  if (event.payload.type === "account.updated") updates.push(event.payload.properties)
}
GlobalBus.on("event", listener)

beforeEach(async () => {
  fixture.requests = []
  fixture.fail = new Set()
  fixture.wallet = 1200
  fixture.available = 1100
  updates.length = 0
  await OpenScience.clearSession()
  await OpenScience.saveSession(session)
})
afterAll(async () => {
  GlobalBus.off("event", listener)
  await OpenScience.clearSession()
  server.stop(true)
  if (previousApiBase === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previousApiBase
  if (previousDeadline === undefined) delete process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS
  else process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = previousDeadline
})

test("a managed spend announces the stale summary at once and the settled one after the delay", async () => {
  const first = await OpenScience.getAccountSummary()
  expect(first?.credits?.balanceUsd).toBe(12)
  expect(first?.credits?.availableCents).toBe(1100)
  expect(updates).toHaveLength(1)

  fixture.wallet = 1000
  fixture.available = 900
  OpenScience.noteManagedSpend()
  OpenScience.noteManagedSpend()
  // Both steps announce the stale summary; the stored values stay on screen
  // (no read of their own) until the one settlement refresh replaces them.
  expect(updates).toHaveLength(3)
  expect(updates.every((update) => update.error === undefined)).toBe(true)
  const stale = await OpenScience.getAccountSummary()
  expect(stale?.credits?.balanceUsd).toBe(12)
  expect(count("/api/v1/wallet")).toBe(1)

  await until(() => updates.length === 4, "the settlement refresh")
  expect(updates[3].error).toBeUndefined()
  expect(count("/api/v1/wallet")).toBe(2)
  const settled = await OpenScience.getAccountSummary()
  expect(settled).toMatchObject({ refreshing: false })
  expect(settled?.credits?.balanceUsd).toBe(10)
  expect(settled?.credits?.availableCents).toBe(900)
  // The next balance gate reads the settled figure rather than the cached one.
  expect(await OpenScience.getBalance(await OpenScience.getFundingSnapshot().then((value) => value!))).toBe(10)
})

test("a settlement refresh that fails is announced with its reason", async () => {
  expect((await OpenScience.getAccountSummary())?.credits?.balanceUsd).toBe(12)
  fixture.fail = new Set(["/api/v1/wallet"])
  OpenScience.noteManagedSpend()
  await until(() => updates.some((update) => update.error !== undefined), "the failure announcement")
  expect(updates.at(-1)?.error).toContain("unavailable")
  const after = await OpenScience.getAccountSummary()
  expect(after?.refreshing).toBe(false)
  expect(after?.error).toContain("unavailable")
  expect(after?.credits?.balanceUsd).toBe(12)
})

test("a background refresh of a stale summary that fails is announced too", async () => {
  expect((await OpenScience.getAccountSummary())?.credits?.balanceUsd).toBe(12)
  // Age the stored summary past its lifetime so the next read refreshes it in the background.
  const stored = JSON.parse(await fs.readFile(snapshotFile, "utf8")) as { at: number }
  await fs.writeFile(snapshotFile, JSON.stringify({ ...stored, at: Date.now() - 60_000 }))
  fixture.fail = new Set(["/api/cli/access"])
  updates.length = 0
  const stale = await OpenScience.getAccountSummary()
  expect(stale?.refreshing).toBe(true)
  await until(() => updates.length === 1, "the failure announcement")
  expect(updates[0].error).toContain("unavailable")
  const after = await OpenScience.getAccountSummary()
  expect(after?.refreshing).toBe(false)
  expect(after?.error).toContain("unavailable")
})
