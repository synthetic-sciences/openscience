import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { BillingSettingsRoutes } from "../../src/server/routes/settings/billing"
import { WalletSettingsRoutes } from "../../src/server/routes/settings/wallet"

const session = path.join(Global.Path.data, "openscience-session.json")
const original = globalThis.fetch

beforeEach(async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await fs.writeFile(session, JSON.stringify({ api_key: "thk_wallet-test", user_id: "user-wallet" }))
  OpenScience.invalidateBalance()
})

afterEach(async () => {
  globalThis.fetch = original
  OpenScience.invalidateBalance()
  await fs.rm(session, { force: true })
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

  const billingResponse = await BillingSettingsRoutes().request("/")
  const billing = await billingResponse.json()
  expect(billing.wallet).toEqual({ signedIn: true, balanceUsd: -1 })
})

test("uses null only when the signed-in balance is genuinely unavailable", async () => {
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch

  const walletResponse = await WalletSettingsRoutes().request("/")
  const wallet = await walletResponse.json()
  expect(wallet).toMatchObject({ signedIn: true, balanceUsd: null })

  const billingResponse = await BillingSettingsRoutes().request("/")
  const billing = await billingResponse.json()
  expect(billing.wallet).toEqual({ signedIn: true, balanceUsd: null })
})
