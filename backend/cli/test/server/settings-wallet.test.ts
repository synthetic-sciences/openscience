import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { BillingSettingsRoutes } from "../../src/server/routes/settings/billing"
import { WalletSettingsRoutes } from "../../src/server/routes/settings/wallet"

const session = path.join(Global.Path.data, "openscience-session.json")
const scope = path.join(Global.Path.data, "openscience-workspace-scope.json")
const original = globalThis.fetch

beforeEach(async () => {
  await OpenScience.waitForBillingModeMirror()
  await fs.rm(scope, { force: true })
  await fs.mkdir(Global.Path.data, { recursive: true })
  await fs.writeFile(session, JSON.stringify({ api_key: "thk_wallet-test", user_id: "user-wallet" }))
  OpenScience.invalidateBalance()
  await Config.updateGlobal({ billing: { llm: null } })
})

afterEach(async () => {
  await OpenScience.waitForBillingModeMirror()
  globalThis.fetch = original
  OpenScience.invalidateBalance()
  await Config.updateGlobal({ billing: { llm: null } })
  await fs.rm(session, { force: true })
  await fs.rm(scope, { force: true })
})

test("uses current Atlas access plus purchased Wallet truth without calling the retired mode write", async () => {
  const calls: Array<{ path: string; method: string }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    calls.push({ path, method })
    if (path === "/api/cli/access") {
      return Response.json({
        managed_supported: true,
        managed_unlocked: false,
        ace_enabled: false,
        cli_balance_cents: 2500,
      })
    }
    if (path === "/api/cli/billing-mode") return new Response("retired", { status: 404 })
    if (path === "/api/v1/wallet") {
      return Response.json({ balance_cents: 2500, purchased_cents: 2000, promotional_cents: 500 })
    }
    if (path === "/api/credits") return Response.json({ lifetime_spent_cents: 750 })
    if (path === "/api/credits/transactions") return Response.json({ transactions: [] })
    if (path === "/api/cli/balance") return Response.json({ balance_cents: 2500, balance_usd: 25 })
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const wallet = await (await WalletSettingsRoutes().request("/")).json()
  expect(wallet).toMatchObject({
    signedIn: true,
    balanceUsd: 20,
    lifetimeSpentUsd: 7.5,
    managedSupported: true,
    managedUnlocked: true,
    aceEnabled: false,
    aceContract: {
      activationAuthorizationUsd: 0,
      reloadThresholdUsd: 5,
      reloadAmountUsd: 20,
      serviceMarginPercent: 2,
      processingFeeDisclosedSeparately: true,
      reloadControlledByAce: true,
    },
  })
  expect(await OpenScience.getBalance()).toBe(25)

  const update = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "managed" }),
  })
  expect(update.status).toBe(200)
  expect(await update.json()).toMatchObject({ llm: "managed", wallet: { signedIn: true, balanceUsd: null } })
  expect(calls.filter((call) => call.path === "/api/cli/billing-mode" && call.method === "POST")).toHaveLength(0)

  const automatic = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: null }),
  })
  expect(automatic.status).toBe(200)
  expect((await automatic.json()).llm).toBeNull()
  await Bun.sleep(10)
  expect(calls.filter((call) => call.path === "/api/cli/billing-mode" && call.method === "POST")).toHaveLength(0)
})

test("settings summaries repair stale locked Personal scope before funded reads", async () => {
  const calls: Array<{ path: string; organization: string | null }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const organization = new Headers(init?.headers).get("X-Organization-ID")
    calls.push({ path, organization })
    if (path === "/api/v1/auth/status") {
      if (organization) return new Response("workspace mismatch", { status: 403 })
      return Response.json({
        api_key: { organization_id: null, workspace_locked: true },
        organizations: [],
        funding_context: { type: "personal", locked: true },
      })
    }
    if (path === "/api/v1/wallet") {
      return Response.json({ balance_cents: 2_000, purchased_cents: 2_000, promotional_cents: 0 })
    }
    if (path === "/api/credits") return Response.json({ lifetime_spent_cents: 500 })
    if (path === "/api/credits/transactions") return Response.json({ transactions: [] })
    if (path === "/api/cli/access") {
      return Response.json({ managed_supported: true, managed_unlocked: true, ace_enabled: true })
    }
    if (path === "/api/cli/billing-mode") return new Response("retired", { status: 404 })
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const stale = {
    api_key: "thk_wallet-test",
    user_id: "user-wallet",
    organization_id: "org_stale",
  }
  const verify = () => {
    expect(calls.some((call) => call.organization === stale.organization_id)).toBe(false)
    expect(
      calls
        .filter((call) =>
          [
            "/api/v1/wallet",
            "/api/credits",
            "/api/credits/transactions",
            "/api/cli/access",
            "/api/cli/billing-mode",
          ].includes(call.path),
        )
        .every((call) => call.organization === null),
    ).toBe(true)
  }

  await Bun.write(session, JSON.stringify(stale))
  OpenScience.invalidateBalance()
  const wallet = await (await WalletSettingsRoutes().request("/")).json()
  expect(wallet).toMatchObject({ signedIn: true, balanceUsd: 20, managedSupported: true })
  expect(await OpenScience.getSession()).toEqual({
    api_key: stale.api_key,
    user_id: stale.user_id,
    workspace_locked: true,
  })
  verify()

  calls.length = 0
  await Bun.write(session, JSON.stringify(stale))
  OpenScience.invalidateBalance()
  const billing = await (await BillingSettingsRoutes().request("/")).json()
  expect(billing.wallet).toEqual({ signedIn: true, balanceUsd: 20 })
  expect(await OpenScience.getSession()).toEqual({
    api_key: stale.api_key,
    user_id: stale.user_id,
    workspace_locked: true,
  })
  verify()
})

test("mirrors an explicit mode to old Atlas even when the shared access endpoint already exists", async () => {
  const calls: Array<{ path: string; method: string }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    calls.push({ path, method })
    if (path === "/api/cli/access") return Response.json({ managed_supported: true, cli_balance_cents: 2000 })
    if (path === "/api/cli/billing-mode") {
      if (method === "POST") return Response.json({ mode: "managed", managed_supported: true, balance_cents: 2000 })
      return Response.json({ mode: "byok", managed_supported: true, balance_cents: 2000, balance_usd: 20 })
    }
    if (path === "/api/cli/sync") {
      return Response.json({
        user: { user_id: "user-wallet" },
        services: {},
        config: {},
        cli_keys_mode: "managed",
      })
    }
    if (path === "/api/v1/wallet") return new Response("not found", { status: 404 })
    if (path === "/api/credits") {
      return Response.json({ balance_cents: 2000, purchased_credits_cents: 2000, cycle_credits_remaining_cents: 0 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const update = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "managed" }),
  })
  expect(update.status).toBe(200)
  expect(await update.json()).toMatchObject({ llm: "managed", wallet: { signedIn: true, balanceUsd: null } })
  await OpenScience.waitForBillingModeMirror()
  expect(calls.filter((call) => call.path === "/api/cli/billing-mode" && call.method === "POST")).toHaveLength(1)
  expect(calls.some((call) => call.path === "/api/cli/sync")).toBe(true)
})

test("maps local Automatic to old Atlas own-key-first compatibility", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })
  const posted: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    if (path === "/api/cli/access") return Response.json({ managed_supported: true })
    if (path === "/api/cli/billing-mode") {
      if (method === "POST") {
        posted.push(String(init?.body))
        return Response.json({ mode: "byok", managed_supported: true, balance_cents: 2000 })
      }
      return Response.json({ mode: "managed", managed_supported: true, balance_cents: 2000, balance_usd: 20 })
    }
    if (path === "/api/cli/sync") return Response.json({ user: { user_id: "user-wallet" }, services: {} })
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const update = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: null }),
  })

  expect(update.status).toBe(200)
  expect((await update.json()).llm).toBeNull()
  for (let index = 0; index < 100 && posted.length === 0; index++) await Bun.sleep(5)
  expect(posted).toHaveLength(1)
  expect(JSON.parse(posted[0]!)).toEqual({ mode: "byok" })
  expect((await Config.getGlobal()).billing?.llm).toBeNull()
})

test("coalesces a delayed legacy mirror so the latest local choice wins", async () => {
  const firstLegacyRead = Promise.withResolvers<Response>()
  const posted: string[] = []
  let legacyReads = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    if (path === "/api/cli/access") return Response.json({ managed_supported: true })
    if (path === "/api/cli/billing-mode" && method === "GET") {
      legacyReads++
      if (legacyReads === 1) return firstLegacyRead.promise
      return Response.json({ mode: "managed", managed_supported: true, balance_cents: 2000, balance_usd: 20 })
    }
    if (path === "/api/cli/billing-mode" && method === "POST") {
      posted.push(String(init?.body))
      return Response.json({ mode: "byok", managed_supported: true, balance_cents: 2000 })
    }
    if (path === "/api/cli/sync") return Response.json({ user: { user_id: "user-wallet" }, services: {} })
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const credits = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "managed" }),
  })
  expect(credits.status).toBe(200)
  for (let index = 0; index < 100 && legacyReads === 0; index++) await Bun.sleep(5)
  expect(legacyReads).toBe(1)

  const automatic = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: null }),
  })
  expect(automatic.status).toBe(200)
  expect((await automatic.json()).llm).toBeNull()

  firstLegacyRead.resolve(
    Response.json({ mode: "byok", managed_supported: true, balance_cents: 2000, balance_usd: 20 }),
  )
  await OpenScience.waitForBillingModeMirror()

  expect(posted.map((body) => JSON.parse(body))).toEqual([{ mode: "byok" }])
  expect((await Config.getGlobal()).billing?.llm).toBeNull()
})

test("saves Accounts locally while signed in even when the compatibility service is unavailable", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch

  const update = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "byok" }),
  })

  expect(update.status).toBe(200)
  expect((await update.json()).llm).toBe("byok")
  expect((await Config.getGlobal()).billing?.llm).toBe("byok")
})

test("acknowledges Accounts before a hanging compatibility read completes", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })
  const hanging = Promise.withResolvers<Response>()
  globalThis.fetch = (async () => hanging.promise) as unknown as typeof fetch

  const request = BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "byok" }),
  })
  const outcome = await Promise.race([
    Promise.resolve(request).then(() => "saved"),
    Bun.sleep(250).then(() => "timed-out"),
  ])

  expect(outcome).toBe("saved")
  expect((await Config.getGlobal()).billing?.llm).toBe("byok")
  hanging.resolve(new Response("unavailable", { status: 503 }))
  await OpenScience.waitForBillingModeMirror()
})

test("saves Accounts locally while signed out", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })
  await fs.rm(session, { force: true })
  globalThis.fetch = (async () => {
    throw new Error("signed-out local update must not call the account service")
  }) as unknown as typeof fetch

  const update = await BillingSettingsRoutes().request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: "byok" }),
  })

  expect(update.status).toBe(200)
  expect((await update.json()).llm).toBe("byok")
  expect((await Config.getGlobal()).billing?.llm).toBe("byok")
})

test("does not invent zero lifetime spend when rolling Atlas omits the field", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    if (path === "/api/v1/wallet") return Response.json({ balance_cents: 2000, purchased_cents: 2000 })
    if (path === "/api/cli/access") return Response.json({ managed_supported: true })
    if (path === "/api/cli/billing-mode") return new Response("retired", { status: 404 })
    if (path === "/api/credits") return new Response("metadata unavailable", { status: 503 })
    if (path === "/api/credits/transactions") return Response.json({ transactions: [] })
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const wallet = await (await WalletSettingsRoutes().request("/")).json()
  expect(wallet).toMatchObject({ signedIn: true, balanceUsd: 20, lifetimeSpentUsd: null })
})

test("preserves a genuine negative balance instead of aliasing it to unavailable", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/api/credits/transactions")) return Response.json({ transactions: [] })
    if (url.endsWith("/api/credits")) {
      return Response.json({ balance_cents: -100, lifetime_spent_cents: 250 })
    }
    if (url.endsWith("/api/cli/billing-mode")) {
      return Response.json({ mode: "managed", balance_cents: -100, balance_usd: -1, managed_supported: true })
    }
    if (url.endsWith("/api/cli/balance")) return Response.json({ balance_usd: -1 })
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch

  const walletResponse = await WalletSettingsRoutes().request("/")
  const wallet = await walletResponse.json()
  expect(wallet).toMatchObject({ signedIn: true, balanceUsd: -1, lifetimeSpentUsd: 2.5 })
  expect(wallet).not.toHaveProperty("plan")

  const billingResponse = await BillingSettingsRoutes().request("/")
  const billing = await billingResponse.json()
  expect(billing.wallet).toEqual({ signedIn: true, balanceUsd: -1 })
})

test("uses null only when the signed-in balance is genuinely unavailable", async () => {
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch

  const walletResponse = await WalletSettingsRoutes().request("/")
  const wallet = await walletResponse.json()
  expect(wallet).toMatchObject({ signedIn: true, balanceUsd: null, lifetimeSpentUsd: null })

  const billingResponse = await BillingSettingsRoutes().request("/")
  const billing = await billingResponse.json()
  expect(billing.wallet).toEqual({ signedIn: true, balanceUsd: null })
})

test("wallet route presents PAYG billing without plan copy", async () => {
  const source = await Bun.file(new URL("../../src/server/routes/settings/wallet.ts", import.meta.url)).text()
  expect(source).toContain("pay-as-you-go Credits")
  expect(source).toContain("Get purchased Wallet balance, routing mode, and recent transactions")
  expect(source).not.toMatch(/subscription|plan mode|manage plan/i)
})
