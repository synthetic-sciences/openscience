import { afterAll, beforeEach, expect, test } from "bun:test"
import path from "node:path"

// Every account surface reads the same status, entitlement and wallet
// endpoints. These tests count the outbound requests one real session
// produces while several surfaces ask at once, and exercise the stored
// account summary those surfaces are served from.
const fixture = {
  requests: [] as string[],
  // Outbound reads the account service saw cancelled (the client went away).
  aborted: [] as string[],
  gate: Promise.resolve(),
  stall: new Set<string>(),
  status: 200,
  wallet: 1200,
}
const headers = { "OpenScience-Funding-Protocol": "1", "OpenScience-Funding-Context": "personal" }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    fixture.requests.push(pathname)
    request.signal.addEventListener("abort", () => fixture.aborted.push(pathname), { once: true })
    if (fixture.stall.has(pathname)) await fixture.gate
    if (pathname === "/api/v1/auth/status") {
      return Response.json(
        {
          user: { user_id: "user_shared", email: "shared@example.com" },
          organizations: [],
          api_key: {},
          funding_context: { type: "personal" },
        },
        { status: fixture.status, headers },
      )
    }
    if (pathname === "/api/cli/access") {
      return Response.json(
        { cli_balance_cents: fixture.wallet, managed_supported: true, managed_unlocked: true, ace_enabled: false },
        { headers },
      )
    }
    if (pathname === "/api/v1/wallet") {
      return Response.json(
        { balance_cents: fixture.wallet, purchased_cents: fixture.wallet, lifetime_spent_cents: 0 },
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
// A short deadline keeps the hung-service case fast; the module reads it once.
process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = "400"
const { OpenScience } = await import("../../src/openscience")
const { SessionProcessor } = await import("../../src/session/processor")
const { GlobalBus } = await import("../../src/bus/global")
const { Global } = await import("../../src/global")
const { AccountRoutes } = await import("../../src/server/routes/account")
const { WalletSettingsRoutes } = await import("../../src/server/routes/settings/wallet")

const ALL = ["/api/v1/auth/status", "/api/cli/access", "/api/v1/wallet", "/api/cli/balance"]
const session = { api_key: "thk_fixture_shared_status", user_id: "user_shared", workspace_locked: true }
const snapshotFile = path.join(Global.Path.data, "openscience-account-snapshot.json")
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

/** Stall the given endpoints until the returned release runs. */
function hold(paths = ALL) {
  const { promise, resolve } = Promise.withResolvers<void>()
  fixture.gate = promise
  fixture.stall = new Set(paths)
  return () => {
    fixture.stall = new Set()
    resolve()
  }
}

beforeEach(async () => {
  fixture.requests = []
  fixture.aborted = []
  fixture.gate = Promise.resolve()
  fixture.stall = new Set()
  fixture.status = 200
  fixture.wallet = 1200
  await OpenScience.saveSession(session)
})
afterAll(async () => {
  await OpenScience.clearSession()
  server.stop(true)
  if (previousApiBase === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previousApiBase
  if (previousDeadline === undefined) delete process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS
  else process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = previousDeadline
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
  expect(state?.verified).toBe(true)
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

test("a managed turn from a scoped session skips the account status read", async () => {
  const funding = await SessionProcessor.fundingSnapshot("managed")
  expect(funding).toMatchObject({ api_key: session.api_key, user_id: "user_shared", workspace_locked: true })
  expect(count("/api/v1/auth/status")).toBe(0)
  // Authorization is still proved before charging: the balance read carries
  // the funding headers and the gateway's echo is validated.
  expect(await OpenScience.getBalance(funding)).toBe(12)
  expect(fixture.requests).toEqual(["/api/cli/balance"])
})

test("a managed turn from a legacy unscoped session still reconciles through status", async () => {
  await OpenScience.saveSession({ api_key: "thk_fixture_legacy_turn", user_id: "" })
  const funding = await SessionProcessor.fundingSnapshot("managed")
  expect(funding?.api_key).toBe("thk_fixture_legacy_turn")
  expect(count("/api/v1/auth/status")).toBe(1)
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

test("stores the first summary, serves it at once and refreshes a stale one in the background", async () => {
  const updates: number[] = []
  const listener = (event: { payload: { type: string; properties: { refreshed_at?: number } } }) => {
    if (event.payload.type === "account.updated") updates.push(event.payload.properties.refreshed_at ?? 0)
  }
  GlobalBus.on("event", listener)
  try {
    // Nothing is stored yet, so the first read waits for the account service.
    const first = await OpenScience.getAccountSummary()
    expect(first).toMatchObject({ refreshing: false, user: { email: "shared@example.com" } })
    expect(first?.credits?.balanceUsd).toBe(12)
    expect(first?.billing?.managed_unlocked).toBe(true)
    expect(updates).toHaveLength(1)
    expect(fixture.requests.sort()).toEqual(["/api/cli/access", "/api/v1/auth/status", "/api/v1/wallet"])
    const stored = await Bun.file(snapshotFile).json()
    expect(stored.key_fingerprint).toHaveLength(64)
    expect(JSON.stringify(stored)).not.toContain(session.api_key)

    // A recent summary is current: served with no account read at all.
    fixture.requests = []
    expect((await OpenScience.getAccountSummary())?.refreshing).toBe(false)
    expect(fixture.requests).toEqual([])

    // A spend makes it stale: it is still served at once, while the account
    // service is slow, and replaced in the background.
    OpenScience.invalidateBalance()
    fixture.wallet = 2500
    const release = hold()
    const stale = await OpenScience.getAccountSummary()
    expect(stale?.refreshing).toBe(true)
    expect(stale?.credits?.balanceUsd).toBe(12)
    expect((await OpenScience.getAccountSummary())?.refreshing).toBe(true)
    await until(() => count("/api/v1/auth/status") === 1, "the background status read")
    release()
    await until(() => updates.length === 2, "the account.updated announcement")
    const current = await OpenScience.getAccountSummary()
    expect(current?.refreshing).toBe(false)
    expect(current?.credits?.balanceUsd).toBe(25)
    expect(current?.at).toBe(updates[1])
  } finally {
    GlobalBus.off("event", listener)
  }
})

test("a failed refresh keeps the last good summary and reports why", async () => {
  const good = await OpenScience.getAccountSummary()
  expect(good?.credits?.balanceUsd).toBe(12)
  OpenScience.invalidateBalance()
  fixture.status = 503
  fixture.requests = []
  const stale = await OpenScience.getAccountSummary()
  expect(stale?.refreshing).toBe(true)
  expect(stale?.error).toBeUndefined()
  await until(() => count("/api/v1/auth/status") === 1, "the failing status read")
  await sleep(50)
  const failed = await OpenScience.getAccountSummary()
  expect(failed?.refreshing).toBe(false)
  expect(failed?.error).toContain("unavailable")
  expect(failed?.credits?.balanceUsd).toBe(12)
  expect(failed?.user?.email).toBe("shared@example.com")
  // The failure backs off: another open panel does not hammer the service.
  await OpenScience.getAccountSummary()
  expect(count("/api/v1/auth/status")).toBe(1)
  expect(await Bun.file(snapshotFile).exists()).toBe(true)
})

test("a stored summary belongs to one account and is dropped on a new sign-in", async () => {
  await OpenScience.getAccountSummary()
  expect(await Bun.file(snapshotFile).exists()).toBe(true)
  await OpenScience.saveSession({
    api_key: "thk_fixture_other_account",
    user_id: "user_shared",
    workspace_locked: true,
  })
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
  const other = (await OpenScience.getFundingSnapshot())!
  expect(await OpenScience.readAccountSnapshot(other)).toBeNull()
  // With nothing stored, the new account's first summary waits for the service.
  hold()
  const pending = OpenScience.getAccountSummary()
  expect(await Promise.race([pending, sleep(50).then(() => "pending")])).toBe("pending")
  await OpenScience.clearSession()
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
})

test("refuses to store a summary after the selected account changed mid-refresh", async () => {
  const before = (await OpenScience.getFundingSnapshot())!
  const release = hold(["/api/v1/wallet"])
  const pending = OpenScience.refreshAccount(before)
  await until(() => count("/api/v1/wallet") === 1, "the stalled wallet read")
  await OpenScience.saveSession({ ...session, user_id: "user_switched" })
  release()
  await expect(pending).rejects.toThrow("selected account changed")
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
})

test("the account and wallet routes serve the stored summary with its refresh state", async () => {
  const account = AccountRoutes()
  const wallet = WalletSettingsRoutes()
  const first = (await (await account.request("/")).json()) as Record<string, unknown>
  expect(first).toMatchObject({
    session: true,
    refreshing: false,
    balance_usd: 12,
    user: { email: "shared@example.com" },
    funding_context: { type: "personal", available: true },
  })
  expect(typeof first.refreshed_at).toBe("number")

  OpenScience.invalidateBalance()
  fixture.requests = []
  const release = hold()
  const summary = (await (await wallet.request("/?summary=true")).json()) as Record<string, unknown>
  expect(summary).toMatchObject({ signedIn: true, refreshing: true, balanceUsd: 12, managedUnlocked: true })
  expect(summary.refreshedAt).toBe(first.refreshed_at)
  release()
  await until(() => count("/api/v1/wallet") === 1, "the background refresh")

  await OpenScience.clearSession()
  const out = (await (await account.request("/")).json()) as Record<string, unknown>
  expect(out).toMatchObject({ session: false, refreshing: false, refreshed_at: null, balance_usd: null })
})

test("a caller that leaves detaches without cancelling a read another caller still waits on", async () => {
  const release = hold(["/api/v1/auth/status"])
  const first = new AbortController()
  const second = new AbortController()
  const one = OpenScience.getAccountSummary({ signal: first.signal })
  const two = OpenScience.getAccountSummary({ signal: second.signal })
  await until(() => count("/api/v1/auth/status") === 1, "the shared status read")
  first.abort()
  await expect(one).rejects.toBeDefined()
  await sleep(30)
  // The second caller keeps the read alive; the account service saw nothing cancelled.
  expect(fixture.aborted).toEqual([])
  release()
  expect((await two)?.credits?.balanceUsd).toBe(12)
  expect(count("/api/v1/auth/status")).toBe(1)
})

test("the last caller to leave cancels the outbound account reads", async () => {
  hold(["/api/v1/auth/status"])
  const controller = new AbortController()
  const pending = OpenScience.getAccountSummary({ signal: controller.signal })
  await until(() => count("/api/v1/auth/status") === 1, "the stalled status read")
  controller.abort()
  await expect(pending).rejects.toBeDefined()
  await until(() => fixture.aborted.includes("/api/v1/auth/status"), "the upstream cancellation")
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
})

test("one bounded deadline ends a hung account service and cancels its read", async () => {
  hold(["/api/v1/auth/status"])
  const started = Date.now()
  await expect(OpenScience.getAccountSummary()).rejects.toBeDefined()
  expect(Date.now() - started).toBeLessThan(OpenScience.ACCOUNT_DEADLINE_MS * 4)
  await until(() => fixture.aborted.includes("/api/v1/auth/status"), "the upstream cancellation")
  // Nothing was stored; the failure is recorded with its reason for the UI.
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
  fixture.stall = new Set()
  const recovered = await OpenScience.getAccountSummary()
  expect(recovered?.credits?.balanceUsd).toBe(12)
})

test("a client leaving the account route cancels the outbound reads through the request signal", async () => {
  const app = AccountRoutes()
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) })
  try {
    hold(["/api/v1/auth/status"])
    const controller = new AbortController()
    const pending = fetch(new URL("/", local.url), { signal: controller.signal }).catch((error: Error) => error.name)
    await until(() => count("/api/v1/auth/status") === 1, "the route's status read")
    controller.abort()
    expect(await pending).toBe("AbortError")
    await until(() => fixture.aborted.includes("/api/v1/auth/status"), "the upstream cancellation")
  } finally {
    local.stop(true)
  }
})

test("a background refresh outlives the request that served the stored summary", async () => {
  await OpenScience.getAccountSummary()
  OpenScience.invalidateBalance()
  fixture.wallet = 3300
  fixture.requests = []
  const app = AccountRoutes()
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) })
  try {
    const release = hold(["/api/v1/auth/status"])
    const served = (await (await fetch(new URL("/", local.url))).json()) as Record<string, unknown>
    expect(served).toMatchObject({ refreshing: true, balance_usd: 12 })
    await until(() => count("/api/v1/auth/status") === 1, "the background status read")
    // The request is complete and its socket idle; the background read must
    // not be tied to it.
    await sleep(50)
    expect(fixture.aborted).toEqual([])
    release()
    await until(() => count("/api/v1/wallet") === 1, "the background wallet read")
    await until(() => !!fixture.requests.length && fixture.aborted.length === 0, "settled")
    await sleep(30)
    const current = (await (await fetch(new URL("/", local.url))).json()) as Record<string, unknown>
    expect(current).toMatchObject({ refreshing: false, balance_usd: 33 })
  } finally {
    local.stop(true)
  }
})
