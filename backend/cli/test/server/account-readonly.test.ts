import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { AccountRoutes } from "../../src/server/routes/account"

const session = path.join(Global.Path.data, "openscience-session.json")
const revision = path.join(Global.Path.data, "credential-revision.json")
const original = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = original
  await Promise.all([fs.rm(session, { force: true }), fs.rm(revision, { force: true })])
  OpenScience.invalidateBalance()
})

test("account GET reads the profile without publishing a credential revision", async () => {
  await fs.rm(revision, { force: true })
  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  OpenScience.invalidateBalance()

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/api/cli/sync")) {
      return Response.json({
        user: { user_id: "user-1", email: "researcher@example.com", subscription_plan: "pro" },
        services: { openai: { connected: true, env: { OPENAI_API_KEY: "must-not-be-applied" } } },
      })
    }
    if (url.endsWith("/api/cli/balance")) return Response.json({ balance_usd: 12.5 })
    if (url.endsWith("/api/cli/billing-mode")) {
      return Response.json({ mode: "byok", balance_cents: 1250, balance_usd: 12.5, managed_supported: true })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const response = await AccountRoutes().request("/")
  const data = await response.json()

  expect(response.status).toBe(200)
  expect(data.user).toEqual({ user_id: "user-1", email: "researcher@example.com", subscription_plan: "pro" })
  expect(data.balance_usd).toBe(12.5)
  expect(data.billing_mode.mode).toBe("byok")
  expect(process.env["OPENAI_API_KEY"]).not.toBe("must-not-be-applied")
  expect(await Bun.file(revision).exists()).toBe(false)
})
