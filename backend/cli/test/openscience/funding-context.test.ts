import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { AccountRoutes } from "../../src/server/routes/account"

const session = path.join(Global.Path.data, "openscience-session.json")
const scope = path.join(Global.Path.data, "openscience-workspace-scope.json")
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
  await Promise.all([
    fs.rm(session, { force: true }),
    fs.rm(scope, { force: true }),
    fs.rm(capabilities, { force: true }),
  ])
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

  test("rejects a standalone organization environment key before managed dispatch", async () => {
    await expect(OpenScience.managedRequestSnapshot("osk_environment.secret")).rejects.toThrow(
      "requires a saved workspace scope",
    )
  })

  test("shows available organizations but requires a separately scoped login to select one", async () => {
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
    expect(selected.status).toBe(400)
    expect(await selected.json()).toEqual({
      error: "Sign in again to create a rollback-safe organization workspace.",
    })
    expect((await Bun.file(session).json()).organization_id).toBeUndefined()

    const rejected = await AccountRoutes().request("/funding-context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: "org_missing" }),
    })
    expect(rejected.status).toBe(400)
    expect((await Bun.file(session).json()).organization_id).toBeUndefined()

    expect(headers).toEqual([null])
  })

  test("requires a fresh login before changing an organization-scoped key", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "osk_org-scoped.secret",
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
    await Bun.write(session, JSON.stringify({ api_key: "osk_old-client.secret", user_id: "user-context" }))
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
      api_key: "osk_old-client.secret",
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

  test("requires a fresh login for a legacy key that Atlas has pinned to an organization", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_old-organization.secret", user_id: "user-context" }))
    globalThis.fetch = (async () =>
      Response.json(
        {
          api_key: { organization_id: alpha.organization_id, workspace_locked: true },
          organizations: [alpha],
          funding_context: { type: "organization", organization_id: alpha.organization_id, locked: true },
        },
        {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": `organization:${alpha.organization_id}`,
          },
        },
      )) as unknown as typeof fetch

    await expect(OpenScience.getFundingContext()).rejects.toThrow("renew this organization workspace credential")
    expect(await OpenScience.getSession()).toEqual({
      api_key: "thk_old-organization.secret",
      user_id: "user-context",
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
    expect(headers).toEqual([null])
    expect(await Bun.file(session).json()).toEqual({
      api_key: "thk_old-personal-selected.secret",
      user_id: "user-context",
      workspace_locked: true,
    })
  })

  test("account summary repairs stale Personal scope before wallet and billing reads", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "thk_old-personal-summary.secret",
        user_id: "user-context",
        organization_id: alpha.organization_id,
      }),
    )
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
      if (path === "/api/cli/sync") {
        return Response.json({ user: { user_id: "user-context", email: "researcher@example.test" }, services: {} })
      }
      if (path === "/api/v1/wallet") {
        return Response.json({ balance_cents: 7_606, purchased_cents: 7_606, promotional_cents: 0 })
      }
      if (path === "/api/credits") return Response.json({ lifetime_spent_cents: 2_500 })
      if (path === "/api/cli/access") {
        return Response.json({ managed_supported: true, managed_unlocked: true, ace_enabled: true })
      }
      if (path === "/api/cli/billing-mode") return new Response("retired", { status: 404 })
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const response = await AccountRoutes().request("/")
    const summary = await response.json()
    expect(response.status).toBe(200)
    expect(summary).toMatchObject({
      session: true,
      user: { user_id: "user-context", email: "researcher@example.test" },
      balance_usd: 76.06,
      billing_mode: { balance_usd: 76.06, managed_unlocked: true },
      funding_context: { type: "personal", available: true, locked: true, organizations: [] },
    })
    expect(await Bun.file(session).json()).toEqual({
      api_key: "thk_old-personal-summary.secret",
      user_id: "user-context",
      workspace_locked: true,
    })
    expect(calls.some((call) => call.organization === alpha.organization_id)).toBe(false)
    expect(
      calls
        .filter((call) =>
          ["/api/v1/wallet", "/api/credits", "/api/cli/access", "/api/cli/billing-mode"].includes(call.path),
        )
        .every((call) => call.organization === null),
    ).toBe(true)
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
    await Bun.write(session, JSON.stringify({ api_key: "osk_removed-member.secret", user_id: "user-context" }))
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
    await Bun.write(session, JSON.stringify({ api_key: "osk_old-client.secret", user_id: "old-user" }))
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

  test("keeps legacy Personal keys personal until a separately scoped browser login", async () => {
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
    await expect(OpenScience.setFundingContext(alpha.organization_id)).rejects.toThrow("rollback-safe")
    expect((await Bun.file(session).json()).organization_id).toBeUndefined()
    expect((await Bun.file(session).json()).workspace_locked).toBeUndefined()
  })

  test("keeps a revoked organization selected and lets Atlas reject it instead of falling back to Personal", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "osk_context.secret",
        user_id: "user-context",
        organization_id: alpha.organization_id,
        workspace_locked: true,
      }),
    )
    const calls: Array<{ path: string; organization: string | null }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const organization = new Headers(init?.headers).get("X-Organization-ID")
      calls.push({ path: url.pathname, organization })
      if (url.pathname.endsWith("/api/v1/auth/status")) {
        return Response.json(
          { organizations: [], funding_context: { type: "personal" } },
          {
            headers: {
              "OpenScience-Funding-Protocol": "1",
              "OpenScience-Funding-Context": `organization:${alpha.organization_id}`,
            },
          },
        )
      }
      if (url.pathname.endsWith("/api/v1/wallet")) return new Response("forbidden", { status: 403 })
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    expect(await OpenScience.getFundingContext()).toEqual({
      type: "organization",
      organization_id: alpha.organization_id,
      available: false,
      locked: true,
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

  test("adds attribution only to funded and workspace-credential calls", async () => {
    await Bun.write(
      session,
      JSON.stringify({
        api_key: "osk_context.secret",
        user_id: "user-context",
        organization_id: alpha.organization_id,
        workspace_locked: true,
      }),
    )
    const calls: Array<{ path: string; organization: string | null }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        path: url.pathname,
        organization: new Headers(init?.headers).get("X-Organization-ID"),
      })
      const response = (value: unknown) =>
        Response.json(value, {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": `organization:${alpha.organization_id}`,
          },
        })
      if (url.pathname.endsWith("/api/v1/wallet")) {
        return response({
          balance_cents: 2_000,
          purchased_cents: 1_500,
          promotional_cents: 500,
          lifetime_spent_cents: 100,
        })
      }
      if (url.pathname.endsWith("/api/credits/transactions")) return response({ transactions: [] })
      if (url.pathname.endsWith("/api/v1/entitlements")) {
        return response({ plan: "team", managed_search: { available: true } })
      }
      if (url.pathname.endsWith("/api/v1/research/search")) return response({ results: [] })
      if (url.pathname.endsWith("/api/cli/usage")) return response({ recorded: true })
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
      "/api/cli/sync",
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
      JSON.stringify({
        api_key: "osk_context-alpha.secret",
        user_id: "user-context",
        organization_id: "org_alpha",
        workspace_locked: true,
      }),
    )
    const reads = { balance: 0, entitlements: 0 }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const organization = new Headers(init?.headers).get("X-Organization-ID")
      const response = (value: unknown) =>
        Response.json(value, {
          headers: organization
            ? {
                "OpenScience-Funding-Protocol": "1",
                "OpenScience-Funding-Context": `organization:${organization}`,
              }
            : undefined,
        })
      if (url.pathname.endsWith("/api/cli/balance")) {
        reads.balance++
        return response({ balance_usd: organization === "org_alpha" ? 10 : 20 })
      }
      if (url.pathname.endsWith("/api/v1/entitlements")) {
        reads.entitlements++
        return response({ plan: organization })
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
      JSON.stringify({
        api_key: "osk_context-beta.secret",
        user_id: "user-context",
        organization_id: "org_beta",
        workspace_locked: true,
      }),
    )
    const second = await OpenScience.getFundingSnapshot()
    expect(await OpenScience.getBalance(second!)).toBe(20)
    expect((await OpenScience.getResearchEntitlements(second!))?.plan).toBe("org_beta")
    expect(reads).toEqual({ balance: 2, entitlements: 2 })
  })

  test("rejects an organization balance when an old gateway omits or mismatches its proof", async () => {
    const snapshot = Object.freeze({
      api_key: "osk_context.secret",
      user_id: "user-context",
      account: "user-context",
      organization_id: alpha.organization_id,
      workspace_locked: true,
    })
    const replies: Array<Record<string, string> | undefined> = [
      undefined,
      {
        "OpenScience-Funding-Protocol": "1",
        "OpenScience-Funding-Context": "personal",
      },
      {
        "OpenScience-Funding-Protocol": "1",
        "OpenScience-Funding-Context": `organization:${alpha.organization_id}`,
      },
    ]
    globalThis.fetch = (async () =>
      Response.json({ balance_usd: 20 }, { headers: replies.shift() })) as unknown as typeof fetch

    expect(await OpenScience.getBalance(snapshot)).toBeNull()
    OpenScience.invalidateBalance()
    expect(await OpenScience.getBalance(snapshot)).toBeNull()
    OpenScience.invalidateBalance()
    expect(await OpenScience.getBalance(snapshot)).toBe(20)
  })

  test("rejects a Personal balance when a modern gateway resolves an organization", async () => {
    const snapshot = Object.freeze({
      api_key: "thk_context.secret",
      user_id: "user-context",
      account: "user-context",
    })
    globalThis.fetch = (async () =>
      Response.json(
        { balance_usd: 20 },
        {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": `organization:${alpha.organization_id}`,
          },
        },
      )) as unknown as typeof fetch

    expect(await OpenScience.getBalance(snapshot)).toBeNull()
  })

  test("preserves concurrent Personal and organization usage cutover markers", async () => {
    const personal = Object.freeze({
      api_key: "thk_context.secret",
      user_id: "user-context",
      account: "user-context",
    })
    const organization = Object.freeze({
      ...personal,
      api_key: "osk_context.secret",
      organization_id: alpha.organization_id,
      workspace_locked: true,
    })
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const id = new Headers(init?.headers).get("X-Organization-ID")
      if (id) await Bun.sleep(10)
      return Response.json(
        { accepted: true, financial: false, billing_authority: "gateway_proxy" },
        {
          headers: id
            ? {
                "OpenScience-Funding-Protocol": "1",
                "OpenScience-Funding-Context": `organization:${id}`,
              }
            : undefined,
        },
      )
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
