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
    if (url.endsWith("/api/v1/wallet")) {
      return Response.json({ balance_cents: 1500, purchased_cents: 1250, promotional_cents: 250 })
    }
    if (url.endsWith("/api/cli/access")) return Response.json({ managed_supported: true })
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
  expect(data.credential).toEqual({ type: "personal", legacy: true })
  expect(process.env["OPENAI_API_KEY"]).not.toBe("must-not-be-applied")
  expect(await Bun.file(revision).exists()).toBe(false)
})

test("account GET reports immutable personal and organization credentials", async () => {
  await Bun.write(
    session,
    JSON.stringify({ api_key: "thk_personal.secret", user_id: "user-1", workspace_locked: true }),
  )
  OpenScience.invalidateBalance()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/api/v1/auth/status")) {
      return Response.json({
        api_key: { organization_id: null, workspace_locked: true },
        organizations: [],
        funding_context: { type: "personal", locked: true },
      })
    }
    if (url.endsWith("/api/cli/sync")) return Response.json({ user: { user_id: "user-1" }, services: {} })
    if (url.endsWith("/api/cli/balance")) return Response.json({ balance_usd: 0 })
    if (url.endsWith("/api/v1/wallet")) return Response.json({ balance_cents: 0 })
    if (url.endsWith("/api/cli/access")) return Response.json({ managed_supported: true })
    if (url.endsWith("/api/cli/billing-mode")) {
      return Response.json({ mode: "byok", balance_cents: 0, balance_usd: 0, managed_supported: true })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const personal = await AccountRoutes().request("/")
  expect((await personal.json()).credential).toEqual({ type: "personal", legacy: true })

  await Bun.write(
    session,
    JSON.stringify({
      api_key: "osk_workspace.secret",
      user_id: "user-1",
      organization_id: "org_alpha",
      workspace_locked: true,
    }),
  )
  OpenScience.invalidateBalance()
  const workspace = await AccountRoutes().request("/")
  expect((await workspace.json()).credential).toEqual({ type: "organization", legacy: false })
})

test("account routes keep unavailable distinct from a real negative balance", async () => {
  const signedOut = await AccountRoutes().request("/")
  expect(await signedOut.json()).toMatchObject({ session: false, balance_usd: null })

  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  OpenScience.invalidateBalance()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/api/v1/wallet")) {
      return Response.json({ balance_cents: -100, purchased_cents: -100, promotional_cents: 0 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const negative = await AccountRoutes().request("/balance")
  expect(await negative.json()).toEqual({ balance_usd: -1 })

  OpenScience.invalidateBalance()
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch
  const unavailable = await AccountRoutes().request("/balance")
  expect(await unavailable.json()).toEqual({ balance_usd: null })
})

test("concurrent balance reads share one control-plane request", async () => {
  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  OpenScience.invalidateBalance()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const state = { calls: 0 }

  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!String(input).endsWith("/api/cli/balance")) return new Response("not found", { status: 404 })
    state.calls++
    started.resolve()
    await gate.promise
    return Response.json({ balance_usd: 12.5 })
  }) as typeof fetch

  const reads = [OpenScience.getBalance(), OpenScience.getBalance(), OpenScience.getBalance()]
  await started.promise
  expect(state.calls).toBe(1)
  gate.resolve()
  expect(await Promise.all(reads)).toEqual([12.5, 12.5, 12.5])
  expect(await OpenScience.getBalance()).toBe(12.5)
  expect(state.calls).toBe(1)
})

test("usage reports supersede an older in-flight balance read", async () => {
  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  OpenScience.invalidateBalance()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/api/cli/balance")) {
      started.resolve()
      await gate.promise
      return Response.json({ balance_usd: 12.5 })
    }
    if (url.endsWith("/api/cli/usage") && init?.method === "POST") {
      return Response.json({ recorded: true, remaining_balance_cents: 700 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const stale = OpenScience.getBalance()
  await started.promise
  const report = await OpenScience.reportUsage({ service: "openai", event_type: "tokens", tokens_used: 1 })
  expect(report?.recorded).toBe(true)
  gate.resolve()
  expect(await stale).toBe(7)
  expect(await OpenScience.getBalance()).toBe(7)
})
