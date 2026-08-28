import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { AccountRoutes } from "../../src/server/routes/account"

const session = path.join(Global.Path.data, "openscience-session.json")
const capabilities = path.join(Global.Path.data, "usage-capabilities.json")
const original = globalThis.fetch

const alpha = {
  organization_id: "org_alpha",
  name: "Alpha Lab",
  slug: "alpha-lab",
  status: "active",
  role: "owner",
  membership_status: "active",
  seat_assigned: true,
  funding_available: true,
  effective_permissions: ["manage_billing", "use_shared_wallet"],
}

const beta = {
  organization_id: "org_beta",
  name: "Beta Lab",
  slug: "beta-lab",
  status: "active",
  role: "member",
  membership_status: "active",
  seat_assigned: true,
  funding_available: true,
  effective_permissions: ["use_shared_wallet"],
}

const unseated = {
  ...beta,
  organization_id: "org_unseated",
  name: "Unseated Lab",
  slug: "unseated-lab",
  seat_assigned: false,
  funding_available: false,
  effective_permissions: [],
}

afterEach(async () => {
  globalThis.fetch = original
  await Promise.all([fs.rm(session, { force: true }), fs.rm(capabilities, { force: true })])
  OpenScience.invalidateBalance()
  OpenScience.invalidateResearchEntitlements()
})

describe("organization funding context", () => {
  test("fails closed on a corrupt persisted organization instead of treating a synced key as Personal", async () => {
    await Bun.write(
      session,
      JSON.stringify({ api_key: "thk_context.secret", user_id: "user-context", organization_id: "../invalid" }),
    )
    expect(await OpenScience.getFundingSnapshot()).toBeNull()
    await expect(OpenScience.managedRequestSnapshot("thk_context.secret")).rejects.toThrow(
      "could not safely read the selected funding account",
    )
  })

  test("reads available organizations and persists only an explicitly validated selection", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_context.secret", user_id: "user-context" }))
    const headers: Array<string | null> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input).endsWith("/api/v1/auth/status")).toBe(true)
      const organization = new Headers(init?.headers).get("X-Organization-ID")
      headers.push(organization)
      return Response.json({
        organizations: [alpha, beta],
        funding_context: organization ? { type: "organization", organization_id: organization } : { type: "personal" },
      })
    }) as typeof fetch

    const initial = await AccountRoutes().request("/funding-context")
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({
      type: "personal",
      available: true,
      locked: false,
      organizations: [alpha, beta],
    })

    const selected = await AccountRoutes().request("/funding-context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: beta.organization_id }),
    })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({
      type: "organization",
      organization_id: beta.organization_id,
      available: true,
    })
    expect((await Bun.file(session).json()).organization_id).toBe(beta.organization_id)

    const confirmed = await AccountRoutes().request("/funding-context")
    expect(await confirmed.json()).toMatchObject({
      type: "organization",
      organization_id: beta.organization_id,
      available: true,
    })

    const rejected = await AccountRoutes().request("/funding-context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: "org_missing" }),
    })
    expect(rejected.status).toBe(400)
    expect((await Bun.file(session).json()).organization_id).toBe(beta.organization_id)

    const personal = await AccountRoutes().request("/funding-context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: null }),
    })
    expect(await personal.json()).toEqual({ type: "personal", available: true, locked: false, organizations: [] })
    expect((await Bun.file(session).json()).organization_id).toBeUndefined()

    // Reads use the selected context. Validation of a new choice deliberately
    // uses Personal so an invalid old organization cannot lock Settings out.
    expect(headers).toEqual([null, null, beta.organization_id, null])
  })

  test("requires a fresh login before changing an organization-scoped key", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "thk_org-scoped.secret",
        user_id: "user-context",
        organization_id: alpha.organization_id,
        workspace_locked: true,
      }),
    )
    globalThis.fetch = (async () => {
      throw new Error("a locked context change must fail before a network request")
    }) as unknown as typeof fetch

    const personal = await AccountRoutes().request("/funding-context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: null }),
    })
    const other = await AccountRoutes().request("/funding-context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: beta.organization_id }),
    })

    expect(personal.status).toBe(400)
    expect(other.status).toBe(400)
    expect(await personal.json()).toEqual({
      error: "This sign-in is tied to one workspace. Sign in again to choose another account.",
    })
    expect((await Bun.file(session).json()).organization_id).toBe(alpha.organization_id)
  })

  test("repairs an organization key saved by an older client before displaying its workspace", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_old-client.secret", user_id: "user-context" }))
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input).endsWith("/api/v1/auth/status")).toBe(true)
      expect(new Headers(init?.headers).get("X-Organization-ID")).toBeNull()
      return Response.json({
        api_key: { organization_id: alpha.organization_id },
        organizations: [alpha],
        funding_context: { type: "organization", organization_id: alpha.organization_id },
      })
    }) as typeof fetch

    expect(await OpenScience.getFundingContext()).toEqual({
      type: "organization",
      organization_id: alpha.organization_id,
      available: true,
      locked: true,
      organizations: [alpha],
    })
    expect(await Bun.file(session).json()).toMatchObject({
      api_key: "thk_old-client.secret",
      user_id: "user-context",
      organization_id: alpha.organization_id,
      workspace_locked: true,
    })
  })

  test("repairs a locked Personal key saved by an older client", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_old-personal.secret", user_id: "user-context" }))
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Organization-ID")).toBeNull()
      return Response.json({
        api_key: { organization_id: null, workspace_locked: true },
        organizations: [],
        funding_context: { type: "personal", locked: true },
      })
    }) as typeof fetch

    expect(await OpenScience.getFundingContext()).toEqual({
      type: "personal",
      available: true,
      locked: true,
      organizations: [],
    })
    expect(await Bun.file(session).json()).toEqual({
      api_key: "thk_old-personal.secret",
      user_id: "user-context",
      workspace_locked: true,
    })
  })

  test("repairs a wrongly selected old-client organization back to locked Personal", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "thk_old-personal-selected.secret",
        user_id: "user-context",
        organization_id: alpha.organization_id,
      }),
    )
    const headers: Array<string | null> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const organization = new Headers(init?.headers).get("X-Organization-ID")
      headers.push(organization)
      if (organization) return new Response("workspace mismatch", { status: 403 })
      return Response.json({
        api_key: { organization_id: null, workspace_locked: true },
        organizations: [],
        funding_context: { type: "personal", locked: true },
      })
    }) as typeof fetch

    expect(await OpenScience.getFundingContext()).toEqual({
      type: "personal",
      available: true,
      locked: true,
      organizations: [],
    })
    expect(headers).toEqual([alpha.organization_id, null])
    expect(await Bun.file(session).json()).toEqual({
      api_key: "thk_old-personal-selected.secret",
      user_id: "user-context",
      workspace_locked: true,
    })
  })

  test("does not unlock a locally locked Personal workspace during a status outage", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "thk_personal-outage.secret",
        user_id: "user-context",
        workspace_locked: true,
      }),
    )
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch

    expect(await OpenScience.getFundingContext()).toEqual({
      type: "personal",
      available: true,
      locked: true,
      organizations: [],
    })
    await expect(OpenScience.setFundingContext(alpha.organization_id)).rejects.toThrow("tied to one workspace")
    expect((await Bun.file(session).json()).workspace_locked).toBe(true)
  })

  test("repairs a removed member's old-client session without falling back to Personal", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_removed-member.secret", user_id: "user-context" }))
    globalThis.fetch = (async () =>
      Response.json({
        api_key: { organization_id: alpha.organization_id },
        organizations: [],
        funding_context: { type: "organization", organization_id: alpha.organization_id },
      })) as unknown as typeof fetch

    expect(await OpenScience.getFundingContext()).toEqual({
      type: "organization",
      organization_id: alpha.organization_id,
      available: false,
      locked: true,
      organizations: [],
    })
    expect(await Bun.file(session).json()).toMatchObject({
      organization_id: alpha.organization_id,
      workspace_locked: true,
    })
  })

  test("does not let a delayed scope repair overwrite a concurrent account change", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_old-client.secret", user_id: "old-user" }))
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    globalThis.fetch = (async () => {
      started.resolve()
      await gate.promise
      return Response.json({
        api_key: { organization_id: alpha.organization_id },
        organizations: [alpha],
        funding_context: { type: "organization", organization_id: alpha.organization_id },
      })
    }) as unknown as typeof fetch

    const pending = OpenScience.getFundingContext()
    await started.promise
    await Bun.write(session, JSON.stringify({ api_key: "thk_new-account.secret", user_id: "new-user" }))
    gate.resolve()
    expect(await pending).toMatchObject({
      type: "organization",
      organization_id: alpha.organization_id,
      locked: true,
    })
    expect(await Bun.file(session).json()).toEqual({ api_key: "thk_new-account.secret", user_id: "new-user" })
  })

  test("does not let a delayed Personal-lock repair overwrite a concurrent login", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_old-personal.secret", user_id: "old-user" }))
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    globalThis.fetch = (async () => {
      started.resolve()
      await gate.promise
      return Response.json({
        api_key: { organization_id: null, workspace_locked: true },
        organizations: [],
        funding_context: { type: "personal", locked: true },
      })
    }) as unknown as typeof fetch

    const pending = OpenScience.getFundingContext()
    await started.promise
    await Bun.write(session, JSON.stringify({ api_key: "thk_new-personal.secret", user_id: "new-user" }))
    gate.resolve()
    expect(await pending).toMatchObject({ type: "personal", locked: true })
    expect(await Bun.file(session).json()).toEqual({ api_key: "thk_new-personal.secret", user_id: "new-user" })
  })

  test("keeps legacy unpinned keys flexible when Atlas reports Personal scope", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_flexible.secret", user_id: "user-context" }))
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const organization = new Headers(init?.headers).get("X-Organization-ID")
      return Response.json({
        api_key: { organization_id: null },
        organizations: [alpha],
        funding_context: organization ? { type: "organization", organization_id: organization } : { type: "personal" },
      })
    }) as typeof fetch

    expect(await OpenScience.getFundingContext()).toMatchObject({ type: "personal", locked: false })
    expect(await OpenScience.setFundingContext(alpha.organization_id)).toMatchObject({
      type: "organization",
      organization_id: alpha.organization_id,
      locked: false,
    })
    expect(await Bun.file(session).json()).toMatchObject({
      organization_id: alpha.organization_id,
    })
    expect((await Bun.file(session).json()).workspace_locked).toBeUndefined()
  })

  test("keeps a revoked organization selected and lets Atlas reject it instead of falling back to Personal", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "thk_context.secret",
        user_id: "user-context",
        organization_id: alpha.organization_id,
      }),
    )
    const calls: Array<{ path: string; organization: string | null }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const organization = new Headers(init?.headers).get("X-Organization-ID")
      calls.push({ path: url.pathname, organization })
      if (url.pathname.endsWith("/api/v1/auth/status")) {
        return Response.json({ organizations: [], funding_context: { type: "personal" } })
      }
      if (url.pathname.endsWith("/api/v1/wallet")) return new Response("forbidden", { status: 403 })
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    expect(await OpenScience.getFundingContext()).toEqual({
      type: "organization",
      organization_id: alpha.organization_id,
      available: false,
      locked: false,
      organizations: [],
    })
    expect(await OpenScience.getCredits()).toBeNull()
    expect((await Bun.file(session).json()).organization_id).toBe(alpha.organization_id)
    expect(calls).toEqual([
      { path: "/api/v1/auth/status", organization: alpha.organization_id },
      { path: "/api/v1/wallet", organization: alpha.organization_id },
    ])
  })

  test("refuses an organization without an active funded seat", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_context.secret", user_id: "user-context" }))
    globalThis.fetch = (async () =>
      Response.json({ organizations: [unseated], funding_context: { type: "personal" } })) as unknown as typeof fetch

    const selected = await AccountRoutes().request("/funding-context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: unseated.organization_id }),
    })
    expect(selected.status).toBe(400)
    expect((await Bun.file(session).json()).organization_id).toBeUndefined()
  })

  test("adds attribution only to funded control-plane calls", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "thk_context.secret",
        user_id: "user-context",
        organization_id: alpha.organization_id,
      }),
    )
    const calls: Array<{ path: string; organization: string | null }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        path: url.pathname,
        organization: new Headers(init?.headers).get("X-Organization-ID"),
      })
      if (url.pathname.endsWith("/api/v1/wallet")) {
        return Response.json({
          balance_cents: 2_000,
          purchased_cents: 1_500,
          promotional_cents: 500,
          lifetime_spent_cents: 100,
        })
      }
      if (url.pathname.endsWith("/api/credits/transactions")) return Response.json({ transactions: [] })
      if (url.pathname.endsWith("/api/v1/entitlements")) {
        return Response.json({ plan: "team", managed_search: { available: true } })
      }
      if (url.pathname.endsWith("/api/v1/research/search")) return Response.json({ results: [] })
      if (url.pathname.endsWith("/api/cli/usage")) return Response.json({ recorded: true })
      if (url.pathname.endsWith("/api/cli/sync")) {
        return Response.json({ user: { user_id: "user-context" }, services: {} })
      }
      if (url.pathname.endsWith("/api/cli/devices")) return Response.json([])
      if (url.pathname.endsWith("/api/cli/installed-skills")) return Response.json([])
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const snapshot = await OpenScience.getFundingSnapshot()
    expect(snapshot).not.toBeNull()
    await OpenScience.getCredits(snapshot!)
    await OpenScience.getTransactions(20, snapshot!)
    await OpenScience.getResearchEntitlements(snapshot!)
    await OpenScience.dispatchResearchSearch(
      { query: "context", source: "research", mode: "fast", limit: 1, content: "snippets" },
      "search-context-1",
      AbortSignal.timeout(1_000),
      snapshot!,
    )
    await OpenScience.reportUsage({ service: "llm", event_type: "chat", tokens_used: 1 }, snapshot!)
    await OpenScience.getProfile(snapshot!)
    await OpenScience.listDevices()
    await OpenScience.fetchLegacyInstalledSkills()

    const funded = new Set([
      "/api/v1/wallet",
      "/api/credits/transactions",
      "/api/v1/entitlements",
      "/api/v1/research/search",
      "/api/cli/usage",
    ])
    for (const call of calls) {
      expect(call.organization, call.path).toBe(funded.has(call.path) ? alpha.organization_id : null)
    }
    expect(calls.some((call) => call.path === "/api/cli/devices")).toBe(true)
    expect(calls.some((call) => call.path === "/api/cli/installed-skills")).toBe(true)
  })

  test("keys balance and entitlement caches by account plus funding context", async () => {
    await Bun.write(
      session,
      JSON.stringify({ api_key: "thk_context.secret", user_id: "user-context", organization_id: "org_alpha" }),
    )
    const reads = { balance: 0, entitlements: 0 }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const organization = new Headers(init?.headers).get("X-Organization-ID")
      if (url.pathname.endsWith("/api/cli/balance")) {
        reads.balance++
        return Response.json({ balance_usd: organization === "org_alpha" ? 10 : 20 })
      }
      if (url.pathname.endsWith("/api/v1/entitlements")) {
        reads.entitlements++
        return Response.json({ plan: organization })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const first = await OpenScience.getFundingSnapshot()
    expect(await OpenScience.getBalance(first!)).toBe(10)
    expect(await OpenScience.getBalance(first!)).toBe(10)
    expect((await OpenScience.getResearchEntitlements(first!))?.plan).toBe("org_alpha")
    expect((await OpenScience.getResearchEntitlements(first!))?.plan).toBe("org_alpha")

    await Bun.write(
      session,
      JSON.stringify({ api_key: "thk_context.secret", user_id: "user-context", organization_id: "org_beta" }),
    )
    const second = await OpenScience.getFundingSnapshot()
    expect(await OpenScience.getBalance(second!)).toBe(20)
    expect((await OpenScience.getResearchEntitlements(second!))?.plan).toBe("org_beta")
    expect(reads).toEqual({ balance: 2, entitlements: 2 })
  })

  test("preserves concurrent Personal and organization usage cutover markers", async () => {
    const personal = Object.freeze({
      api_key: "thk_context.secret",
      user_id: "user-context",
      account: "user-context",
    })
    const organization = Object.freeze({ ...personal, organization_id: alpha.organization_id })
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).get("X-Organization-ID")) await Bun.sleep(10)
      return Response.json({ accepted: true, financial: false, billing_authority: "gateway_proxy" })
    }) as typeof fetch

    await Promise.all([
      OpenScience.reportUsage({ service: "llm", event_type: "chat", tokens_used: 1 }, personal),
      OpenScience.reportUsage({ service: "llm", event_type: "chat", tokens_used: 1 }, organization),
    ])

    expect(await Bun.file(capabilities).json()).toMatchObject({
      accounts: {
        ["user-context\u0000personal"]: { nonfinancial: true },
        [`user-context\u0000organization:${alpha.organization_id}`]: { nonfinancial: true },
      },
    })
  })
})
