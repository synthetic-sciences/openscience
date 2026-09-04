import { afterAll, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// Every account surface reads the same status, entitlement and wallet
// endpoints. These tests count the outbound requests one real session
// produces while several surfaces ask at once, and exercise the stored
// account summary those surfaces are served from.
const fixture = {
  requests: [] as string[],
  // Outbound reads the account service answered, in the order it answered
  // them: a read held at the gate lands here after every read it waited for.
  answered: [] as string[],
  // Outbound reads the account service saw cancelled (the client went away).
  aborted: [] as string[],
  gate: Promise.resolve(),
  stall: new Set<string>(),
  // Endpoints that answer 503, the way a transient outage does.
  fail: new Set<string>(),
  status: 200,
  // What /api/cli/access answers: 200, or an explicit refusal (401, 403).
  access: 200,
  wallet: 1200,
}
// The profile the account service returns carries more than the UI shows;
// only the shown fields may reach the stored summary.
const profile = {
  user_id: "user_shared",
  email: "shared@example.com",
  display_name: "Shared User",
  session_token: "srv_profile_secret",
}
const headers = { "OpenScience-Funding-Protocol": "1", "OpenScience-Funding-Context": "personal" }
async function answer(pathname: string): Promise<Response> {
  if (fixture.stall.has(pathname)) await fixture.gate
  if (fixture.fail.has(pathname)) return new Response(null, { status: 503 })
  if (pathname === "/api/v1/auth/status") {
    return Response.json(
      {
        user: profile,
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
      { status: fixture.access, headers },
    )
  }
  if (pathname === "/api/credits/transactions") return Response.json([], { headers })
  if (pathname === "/api/v1/wallet") {
    return Response.json(
      { balance_cents: fixture.wallet, purchased_cents: fixture.wallet, lifetime_spent_cents: 0 },
      { headers },
    )
  }
  if (pathname === "/api/cli/balance")
    return Response.json({ effective_balance_usd: fixture.wallet / 100 }, { headers })
  return new Response(null, { status: 404 })
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    fixture.requests.push(pathname)
    request.signal.addEventListener("abort", () => fixture.aborted.push(pathname), { once: true })
    const response = await answer(pathname)
    fixture.answered.push(pathname)
    return response
  },
})
const previousApiBase = process.env.OPENSCIENCE_API_BASE
const previousDeadline = process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS
process.env.OPENSCIENCE_API_BASE = server.url.toString()
// The deadline is read per call. Every test runs under a long one so
// cancellation is only ever caused by the test itself; the hung-service case
// shortens it for its own duration.
process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = "15000"
const { OpenScience } = await import("../../src/openscience")
const { SessionProcessor } = await import("../../src/session/processor")
const { GlobalBus } = await import("../../src/bus/global")
const { Global } = await import("../../src/global")
const { AccountRoutes } = await import("../../src/server/routes/account")
const { WalletSettingsRoutes, readWallet } = await import("../../src/server/routes/settings/wallet")

const ALL = ["/api/v1/auth/status", "/api/cli/access", "/api/v1/wallet", "/api/cli/balance"]
const session = { api_key: "thk_fixture_shared_status", user_id: "user_shared", workspace_locked: true }
const sessionFile = path.join(Global.Path.data, "openscience-session.json")
const snapshotFile = path.join(Global.Path.data, "openscience-account-snapshot.json")
const count = (pathname: string) => fixture.requests.filter((item) => item === pathname).length
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for observable state to reach `check`. Nothing here waits for a fixed
 * time: the deadline is generous so a loaded runner is never the reason a wait
 * fails, and a wait that does expire is a real failure with a name. */
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

type Summary = Awaited<ReturnType<typeof OpenScience.getAccountSummary>>

/** The summary once the background refresh running for it has settled, failure
 * included. Reading it while that refresh is in flight joins the read instead
 * of starting another, so waiting this way adds no request of its own. */
async function settled(what: string): Promise<Summary> {
  const seen: { summary: Summary } = { summary: null }
  await until(async () => {
    seen.summary = await OpenScience.getAccountSummary()
    return seen.summary?.refreshing === false
  }, what)
  return seen.summary
}

const held = { release: undefined as (() => void) | undefined }

/** Resolves with the next `account.updated` announcement's refreshed_at. */
function nextUpdate(): Promise<number> {
  return new Promise((resolve) => {
    const listener = (event: { payload: { type: string; properties: { refreshed_at?: number } } }) => {
      if (event.payload.type !== "account.updated") return
      GlobalBus.off("event", listener)
      resolve(event.payload.properties.refreshed_at ?? 0)
    }
    GlobalBus.on("event", listener)
  })
}

/** Date the stored summary `ms` back, as one read that long ago: old enough
 * that a spend since makes the next read refresh it. Returns its new `at`. */
async function age(ms = 10_000): Promise<number> {
  const stored = (await Bun.file(snapshotFile).json()) as Record<string, unknown>
  const at = Date.now() - ms
  await Bun.write(snapshotFile, JSON.stringify({ ...stored, at }))
  return at
}

/** Stall the given endpoints until the returned release runs. */
function hold(paths = ALL) {
  const { promise, resolve } = Promise.withResolvers<void>()
  fixture.gate = promise
  fixture.stall = new Set(paths)
  held.release = () => {
    fixture.stall = new Set()
    held.release = undefined
    resolve()
  }
  return held.release
}

beforeEach(async () => {
  // A failed test must not leave the account service stalled for the next.
  held.release?.()
  fixture.requests = []
  fixture.answered = []
  fixture.aborted = []
  fixture.gate = Promise.resolve()
  fixture.stall = new Set()
  fixture.fail = new Set()
  fixture.status = 200
  fixture.access = 200
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
  const current = (await OpenScience.getFundingSnapshot())!
  const release = hold()
  // One surface starts the read; the service holds it until it is released.
  const first = OpenScience.getReconciledFundingState()
  await until(() => count("/api/v1/auth/status") === 1, "the first status read")
  // Every surface that asks while it is in flight joins it. Each of these is
  // handed the session, so it reaches the shared read in the tick it is
  // called and the read may settle as soon as they are all started.
  const pending = Promise.all([
    first,
    OpenScience.getFundingContext(current),
    OpenScience.getProfile(current),
    OpenScience.getProfile(current),
  ])
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
  expect(state?.user).toEqual(profile)
  expect(state?.verified).toBe(true)
  expect(count("/api/v1/auth/status")).toBe(1)
})

test("concurrent billing-mode reads share one entitlement and one wallet request", async () => {
  const snapshot = (await OpenScience.getFundingSnapshot())!
  const release = hold()
  // Every caller is handed the session, so all three reach their shared reads
  // in the tick they are called: the reads may settle from here on.
  const pending = Promise.all([
    OpenScience.getBillingMode(snapshot),
    OpenScience.getBillingMode(snapshot),
    OpenScience.getCredits(snapshot),
  ])
  await until(() => count("/api/cli/access") === 1 && count("/api/v1/wallet") === 1, "the first reads")
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
  // Handed the session, each caller reaches its flight in the tick it is
  // called: the two summary reads share one, the full read is its own.
  const pending = Promise.all([
    OpenScience.getCredits(snapshot, { lifetimeSpent: false }),
    OpenScience.getCredits(snapshot),
    OpenScience.getCredits(snapshot, { lifetimeSpent: false }),
  ])
  await until(() => count("/api/v1/wallet") === 2, "both wallet reads")
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
    expect(first).toMatchObject({ refreshing: false })
    expect(first?.user).toEqual({ user_id: "user_shared", email: "shared@example.com", display_name: "Shared User" })
    expect(first?.credits?.balanceUsd).toBe(12)
    expect(first?.billing?.managed_unlocked).toBe(true)
    expect(updates).toHaveLength(1)
    expect(fixture.requests.sort()).toEqual(["/api/cli/access", "/api/v1/auth/status", "/api/v1/wallet"])
    const stored = await Bun.file(snapshotFile).json()
    expect(stored.key_fingerprint).toHaveLength(64)
    expect(JSON.stringify(stored)).not.toContain(session.api_key)
    // The stored profile holds exactly the shown fields; nothing else the
    // account service sent with it is persisted. The file is private.
    expect(Object.keys(stored.user).sort()).toEqual(["display_name", "email", "user_id"])
    expect(JSON.stringify(stored)).not.toContain(profile.session_token)
    if (process.platform !== "win32") expect((await fs.stat(snapshotFile)).mode & 0o777).toBe(0o600)

    // A recent summary is current: served with no account read at all.
    fixture.requests = []
    expect((await OpenScience.getAccountSummary())?.refreshing).toBe(false)
    expect(fixture.requests).toEqual([])

    // A spend after a summary older than the refresh interval makes it
    // stale: it is still served at once, while the account service is slow,
    // and replaced in the background.
    await age()
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
  await age()
  OpenScience.invalidateBalance()
  fixture.status = 503
  fixture.requests = []
  const stale = await OpenScience.getAccountSummary()
  expect(stale?.refreshing).toBe(true)
  expect(stale?.error).toBeUndefined()
  await until(() => count("/api/v1/auth/status") === 1, "the failing status read")
  const failed = await settled("the failed refresh")
  expect(failed?.refreshing).toBe(false)
  expect(failed?.error).toContain("unavailable")
  expect(failed?.credits?.balanceUsd).toBe(12)
  expect(failed?.user?.email).toBe("shared@example.com")
  // The failure backs off: another open panel does not hammer the service.
  await OpenScience.getAccountSummary()
  expect(count("/api/v1/auth/status")).toBe(1)
  expect(await Bun.file(snapshotFile).exists()).toBe(true)
})

test("a wallet or entitlement read that did not answer keeps the last good summary", async () => {
  const good = await OpenScience.getAccountSummary()
  expect(good?.credits?.balanceUsd).toBe(12)
  const at = await age()
  OpenScience.invalidateBalance()
  fixture.fail = new Set(["/api/v1/wallet", "/api/cli/access"])
  fixture.requests = []
  const stale = await OpenScience.getAccountSummary()
  expect(stale?.refreshing).toBe(true)
  expect(stale?.error).toBeUndefined()
  await until(() => count("/api/v1/wallet") === 1 && count("/api/cli/access") === 1, "the failing reads")
  // The incomplete read was not stored: the good summary is served with the
  // failure, and the file still holds it.
  const failed = await settled("the failed refresh")
  expect(failed?.refreshing).toBe(false)
  expect(failed?.error).toContain("unavailable")
  expect(failed?.credits?.balanceUsd).toBe(12)
  expect(failed?.billing).toMatchObject({ access_verified: true, managed_unlocked: true })
  expect(failed?.at).toBe(at)
  const stored = await Bun.file(snapshotFile).json()
  expect(stored.at).toBe(at)
  expect(stored.credits.balanceUsd).toBe(12)
  expect(stored.billing.access_verified).toBe(true)
  // The failure backs off like any other.
  expect(count("/api/v1/auth/status")).toBe(1)
})

test("a spend right after a refresh does not start another one", async () => {
  // Every open panel re-reads the summary when a refresh is announced, and a
  // managed turn spends between announcements. That re-read must not start
  // the next refresh, or each model response costs three account reads.
  const first = await OpenScience.getAccountSummary()
  fixture.requests = []
  OpenScience.invalidateBalance()
  const one = await OpenScience.getAccountSummary()
  OpenScience.invalidateBalance()
  const two = await OpenScience.getAccountSummary()
  // A read that starts a refresh says so in the summary it returns, so
  // `refreshing: false` on both is the proof that neither did. The triple
  // counted at the end covers everything since, so nothing followed either.
  expect(one).toMatchObject({ refreshing: false, at: first!.at })
  expect(two).toMatchObject({ refreshing: false, at: first!.at })
  expect(fixture.requests).toEqual([])
  // Past the interval one refresh runs; its announcement is served to every
  // re-read as current, with another spend in between: one triple in all.
  await age()
  OpenScience.invalidateBalance()
  fixture.wallet = 2500
  const updated = nextUpdate()
  expect((await OpenScience.getAccountSummary())?.refreshing).toBe(true)
  await updated
  OpenScience.invalidateBalance()
  const [panel, other] = await Promise.all([OpenScience.getAccountSummary(), OpenScience.getAccountSummary()])
  expect(panel).toMatchObject({ refreshing: false, credits: { balanceUsd: 25 } })
  expect(other?.at).toBe(panel!.at)
  // Counted since the first summary: one refresh in all. A read started by
  // any re-read above would have gone out while this one was still running.
  expect(fixture.requests.sort()).toEqual(["/api/cli/access", "/api/v1/auth/status", "/api/v1/wallet"])
})

test("an entitlement refusal is answered but never stored", async () => {
  const good = await OpenScience.getAccountSummary()
  expect(good?.billing?.managed_unlocked).toBe(true)
  await age()
  OpenScience.invalidateBalance()
  fixture.access = 403
  // The stale good summary is served while the refresh runs; the refusal
  // then drops it and is announced, so open panels re-read.
  const updated = nextUpdate()
  expect((await OpenScience.getAccountSummary())?.refreshing).toBe(true)
  await updated
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
  // The re-read waits for the gateway and gets its verdict, not a cached
  // one; every read asks again until access is restored.
  fixture.requests = []
  const denied = await OpenScience.getAccountSummary()
  expect(denied).toMatchObject({ refreshing: false, credits: { balanceUsd: 12 } })
  expect(denied?.error).toBeUndefined()
  expect(denied?.billing).toMatchObject({ access_verified: true, managed_supported: false, managed_unlocked: false })
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
  expect(count("/api/cli/access")).toBe(1)
  const wallet = await readWallet(true)
  expect(wallet).toMatchObject({ signedIn: true, accessVerified: true, managedUnlocked: false, refreshing: false })
  expect(wallet.error).toBeUndefined()
  expect(count("/api/cli/access")).toBe(2)
  // Restored access is seen by the next read, which stores a summary again.
  fixture.access = 200
  const restored = await OpenScience.getAccountSummary()
  expect(restored?.billing?.managed_unlocked).toBe(true)
  expect((await Bun.file(snapshotFile).json()).billing.managed_unlocked).toBe(true)
})

test("a rejected key ends the session and drops the stored summary", async () => {
  await OpenScience.getAccountSummary()
  expect(await Bun.file(snapshotFile).exists()).toBe(true)
  fixture.access = 401
  const current = (await OpenScience.getFundingSnapshot())!
  await expect(OpenScience.refreshAccount(current)).rejects.toThrow("disconnected")
  expect(await Bun.file(sessionFile).exists()).toBe(false)
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
  expect(await OpenScience.getAccountSummary()).toBeNull()
})

test("a corrupt stored summary is ignored and the next read waits for the account service", async () => {
  await OpenScience.getAccountSummary()
  await Bun.write(snapshotFile, "{not a summary")
  const current = (await OpenScience.getFundingSnapshot())!
  expect(await OpenScience.readAccountSnapshot(current)).toBeNull()
  fixture.requests = []
  const release = hold()
  const pending = OpenScience.getAccountSummary()
  // Nothing usable is stored, so the caller waits for the account service:
  // it is still pending when the read it is waiting on reaches the fixture.
  expect(
    await Promise.race([
      pending.then(() => "answered"),
      until(() => count("/api/v1/auth/status") === 1, "the status read").then(() => "waiting"),
    ]),
  ).toBe("waiting")
  release()
  const fresh = await pending
  expect(fresh?.refreshing).toBe(false)
  expect(fresh?.credits?.balanceUsd).toBe(12)
  expect((await Bun.file(snapshotFile).json()).credits.balanceUsd).toBe(12)
})

test("a stored summary is bound to the session's account and funding context", async () => {
  await OpenScience.getAccountSummary()
  const current = (await OpenScience.getFundingSnapshot())!
  expect(await OpenScience.readAccountSnapshot(current)).not.toBeNull()
  expect(await OpenScience.readAccountSnapshot({ ...current, organization_id: "org_other" })).toBeNull()
  expect(await OpenScience.readAccountSnapshot({ ...current, user_id: "user_other" })).toBeNull()
  expect(await OpenScience.readAccountSnapshot({ ...current, workspace_locked: false })).toBeNull()
})

test("a stored summary dated in the future is served as stale and replaced", async () => {
  const first = await OpenScience.getAccountSummary()
  const stored = await Bun.file(snapshotFile).json()
  await Bun.write(snapshotFile, JSON.stringify({ ...stored, at: Date.now() + 3_600_000 }))
  fixture.requests = []
  const updated = nextUpdate()
  const served = await OpenScience.getAccountSummary()
  expect(served?.refreshing).toBe(true)
  expect(served?.at).toBeLessThanOrEqual(Date.now())
  expect(served?.credits?.balanceUsd).toBe(12)
  await updated
  const current = await OpenScience.getAccountSummary()
  expect(current?.refreshing).toBe(false)
  expect(current?.at).toBeGreaterThanOrEqual(first!.at)
  expect(current?.at).toBeLessThanOrEqual(Date.now())
  expect(count("/api/v1/auth/status")).toBe(1)
})

test("a caller's own cancellation is not recorded as an account failure", async () => {
  await OpenScience.getAccountSummary()
  await age()
  OpenScience.invalidateBalance()
  fixture.requests = []
  const current = (await OpenScience.getFundingSnapshot())!
  hold(["/api/v1/wallet"])
  const controller = new AbortController()
  const pending = OpenScience.refreshAccount(current, { signal: controller.signal })
  await until(() => count("/api/v1/wallet") === 1, "the stalled wallet read")
  controller.abort()
  await expect(pending).rejects.toBeDefined()
  await until(() => fixture.aborted.includes("/api/v1/wallet"), "the upstream cancellation")
  held.release?.()
  // The stored summary is stale, so the next read starts a new refresh
  // instead of serving the cancellation as a failure under the backoff.
  fixture.requests = []
  const updated = nextUpdate()
  const next = await OpenScience.getAccountSummary()
  expect(next?.error).toBeUndefined()
  expect(next?.refreshing).toBe(true)
  await updated
  expect(count("/api/v1/wallet")).toBe(1)
  expect((await OpenScience.getAccountSummary())?.refreshing).toBe(false)
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
  fixture.requests = []
  const release = hold()
  const pending = OpenScience.getAccountSummary().catch(() => "gone")
  expect(
    await Promise.race([
      pending.then(() => "answered"),
      until(() => count("/api/v1/auth/status") === 1, "the new account's status read").then(() => "waiting"),
    ]),
  ).toBe("waiting")
  await OpenScience.clearSession()
  expect(await Bun.file(snapshotFile).exists()).toBe(false)
  // Signed out mid-read, the waiting caller is left with nothing to store.
  release()
  expect(await pending).toBe("gone")
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

  const at = await age()
  OpenScience.invalidateBalance()
  fixture.requests = []
  const release = hold()
  const summary = (await (await wallet.request("/?summary=true")).json()) as Record<string, unknown>
  expect(summary).toMatchObject({ signedIn: true, refreshing: true, balanceUsd: 12, managedUnlocked: true })
  expect(summary.refreshedAt).toBe(at)
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
  release()
  // The second caller kept the read alive: it answered and served the summary,
  // which a read cancelled with the first caller could never have done, and
  // the account service saw nothing cancelled along the way.
  expect((await two)?.credits?.balanceUsd).toBe(12)
  expect(fixture.aborted).toEqual([])
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
  process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = "400"
  try {
    expect(OpenScience.accountDeadlineMs()).toBe(400)
    hold(["/api/v1/auth/status"])
    const started = Date.now()
    // The deadline's reason is what the waiting caller, and so the UI, sees.
    const failure = await OpenScience.getAccountSummary().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).toContain("did not answer within")
    expect(Date.now() - started).toBeLessThan(4_000)
    await until(() => fixture.aborted.includes("/api/v1/auth/status"), "the upstream cancellation")
    // Nothing was stored; the failure is recorded with its reason for the UI.
    expect(await Bun.file(snapshotFile).exists()).toBe(false)
    held.release?.()
    const recovered = await OpenScience.getAccountSummary()
    expect(recovered?.credits?.balanceUsd).toBe(12)
  } finally {
    process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = "15000"
  }
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
  await age()
  OpenScience.invalidateBalance()
  fixture.wallet = 3300
  fixture.requests = []
  const app = AccountRoutes()
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) })
  try {
    const release = hold(["/api/v1/auth/status"])
    const refreshed = nextUpdate()
    const served = (await (await fetch(new URL("/", local.url))).json()) as Record<string, unknown>
    expect(served).toMatchObject({ refreshing: true, balance_usd: 12 })
    // The request is complete and its socket idle, while the read it left
    // behind is still out at the account service.
    await until(() => count("/api/v1/auth/status") === 1, "the background status read")
    release()
    // It answers and the refresh carries on to the wallet: had the read been
    // tied to the request that started it, it would have been cancelled when
    // that request returned and nothing would have followed it.
    await until(() => count("/api/v1/wallet") === 1, "the background wallet read")
    expect(fixture.aborted).toEqual([])
    // The refresh announces itself once it has stored what it read, so the
    // next request over a fresh socket is served the new summary.
    const at = await refreshed
    const current = (await (await fetch(new URL("/", local.url))).json()) as Record<string, unknown>
    expect(current).toMatchObject({ refreshing: false, balance_usd: 33, refreshed_at: at })
  } finally {
    local.stop(true)
  }
})

test("a caller joining right after the last waiter left starts its own read", async () => {
  const current = (await OpenScience.getFundingSnapshot())!
  const release = hold(["/api/v1/auth/status"])
  const controller = new AbortController()
  const left = OpenScience.refreshAccount(current, { signal: controller.signal })
  await until(() => count("/api/v1/auth/status") === 1, "the first status read")
  controller.abort()
  // Joins in the same tick as the cancellation, before the cancelled read
  // settles: it is not joined, the newcomer's own read goes out.
  const joined = OpenScience.refreshAccount(current)
  await expect(left).rejects.toBeDefined()
  await until(() => count("/api/v1/auth/status") === 2, "the newcomer's status read")
  release()
  expect((await joined).credits?.balanceUsd).toBe(12)
})

test("the ledger view of a legacy unscoped session learns its workspace before reading the ledger", async () => {
  await OpenScience.saveSession({ api_key: "thk_fixture_legacy_ledger", user_id: "" })
  const release = hold(["/api/v1/auth/status"])
  const pending = readWallet(false)
  await until(() => count("/api/v1/auth/status") === 1, "the status read")
  expect(count("/api/credits/transactions")).toBe(0)
  release()
  const wallet = await pending
  expect(wallet).toMatchObject({ signedIn: true, balanceUsd: 12, transactions: [] })
  // One status read served both the summary and the ledger, and the ledger
  // waited for it: a read that had gone out alongside would have been
  // answered first, while the status read was still held.
  expect(count("/api/v1/auth/status")).toBe(1)
  expect(count("/api/credits/transactions")).toBe(1)
  expect(fixture.answered.indexOf("/api/v1/auth/status")).toBeLessThan(
    fixture.answered.indexOf("/api/credits/transactions"),
  )
})
