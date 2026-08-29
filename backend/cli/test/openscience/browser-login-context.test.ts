import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { API_BASE, OpenScience } from "../../src/openscience"

const original = globalThis.fetch
const session = path.join(Global.Path.data, "openscience-session.json")
const scope = path.join(Global.Path.data, "openscience-workspace-scope.json")
const queue = path.join(Global.Path.data, "telemetry-queue-v2.jsonl")
const config = path.join(process.env.XDG_CONFIG_HOME!, "openscience")
const synced = path.join(config, "synced-env.json")
const settings = path.join(config, "openscience-synced.json")

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

type Reply = {
  api_key?: string
  key?: string
  organization_id?: unknown
  workspace_locked?: unknown
  user?: { id?: string; user_id?: string }
  user_id?: string
}

async function gateway(reply: Reply) {
  const state = {
    reply,
    starts: [] as Array<Record<string, string>>,
    redeems: [] as Array<Record<string, string>>,
    funded: [] as Array<{ key: string | null; organization: string | null }>,
    syncs: [] as Array<{ key: string | null; organization: string | null }>,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const organization = request.headers.get("X-Organization-ID")
      const json = (value: unknown) =>
        Response.json(value, {
          headers: organization
            ? {
                "OpenScience-Funding-Protocol": "1",
                "OpenScience-Funding-Context": `organization:${organization}`,
              }
            : undefined,
        })
      if (url.pathname === "/api/v1/auth/cli/browser/start") {
        const body = (await request.json()) as Record<string, string>
        state.starts.push(body)
        const target = new URL("/approve", server.url)
        target.searchParams.set("state", body.state)
        target.searchParams.set("redirect_uri", body.redirect_uri)
        target.searchParams.set("exchange_token", `exchange-${state.starts.length}`)
        return json({ approval_url: target.toString() })
      }
      if (url.pathname === "/approve") {
        const target = new URL(url.searchParams.get("redirect_uri")!)
        target.searchParams.set("state", url.searchParams.get("state")!)
        target.searchParams.set("exchange_token", url.searchParams.get("exchange_token")!)
        return Response.redirect(target.toString(), 302)
      }
      if (url.pathname === "/api/v1/auth/cli/browser/redeem") {
        state.redeems.push((await request.json()) as Record<string, string>)
        return json(state.reply)
      }
      if (url.pathname === "/api/v1/auth/status") {
        const key = request.headers.get("Authorization")
        if (key === "Bearer osk_browser-org.secret" || key === "Bearer osk_pasted-org.secret") {
          return json({
            api_key: { organization_id: alpha.organization_id, workspace_locked: true },
            organizations: [alpha],
            funding_context: { type: "organization", organization_id: alpha.organization_id, locked: true },
          })
        }
        if (key === "Bearer thk_browser-personal.secret") {
          return json({
            api_key: { organization_id: null, workspace_locked: true },
            organizations: [],
            funding_context: { type: "personal", locked: true },
          })
        }
        if (key === "Bearer thk_pasted-personal.secret") {
          return json({
            api_key: { organization_id: null, workspace_locked: true },
            organizations: [],
            funding_context: { type: "personal", locked: true },
          })
        }
        if (key === "Bearer thk_legacy-selected.secret") {
          return json({
            api_key: { organization_id: null, workspace_locked: false },
            organizations: [alpha],
            funding_context: {
              type: "organization",
              organization_id: alpha.organization_id,
              locked: false,
            },
          })
        }
        if (key === "Bearer thk_legacy-personal.secret") return new Response("not found", { status: 404 })
        if (key === "Bearer osk_unverified.secret") return new Response("status offline", { status: 500 })
        return json({ organizations: [alpha], funding_context: { type: "personal" } })
      }
      if (url.pathname === "/api/v1/wallet") {
        state.funded.push({
          key: request.headers.get("Authorization"),
          organization: request.headers.get("X-Organization-ID"),
        })
        return json({ balance_cents: 2000, purchased_cents: 2000, lifetime_spent_cents: 0 })
      }
      if (url.pathname === "/api/cli/balance") return json({ balance_cents: 2000, balance_usd: 20 })
      if (url.pathname === "/api/cli/sync") {
        state.syncs.push({
          key: request.headers.get("Authorization"),
          organization: request.headers.get("X-Organization-ID"),
        })
        return json({
          user: {
            user_id:
              request.headers.get("Authorization") === "Bearer osk_pasted-org.secret"
                ? "user-pasted-org"
                : "user-legacy",
          },
          services: {},
        })
      }
      if (url.pathname === "/api/v1/telemetry/consent") {
        return json({
          consent_version: 2,
          analytics_enabled: true,
          research_content_enabled: true,
          consent_epoch: "e".repeat(32),
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const source = new URL(input instanceof Request ? input.url : String(input))
    if (source.origin !== new URL(API_BASE).origin) return original(input, init)
    const target = new URL(`${source.pathname}${source.search}`, server.url)
    return original(target, init)
  }) as typeof fetch
  return {
    state,
    close: async () => {
      globalThis.fetch = original
      await server.stop(true)
    },
  }
}

async function login() {
  const opened: Promise<Response>[] = []
  const result = await OpenScience.browserLogin({
    timeoutMs: 2_000,
    onApprovalUrl(url) {
      opened.push(fetch(url))
    },
  })
  await Promise.all(opened)
  return result
}

afterEach(async () => {
  globalThis.fetch = original
  delete process.env.GITHUB_TOKEN
  await Promise.all(
    [session, scope, queue, synced, settings].map((target) => fs.rm(target, { force: true }).catch(() => {})),
  )
  OpenScience.invalidateBalance()
  OpenScience.invalidateResearchEntitlements()
})

describe("browser login funding context", () => {
  test("persists the approved organization and replaces it with a clean legacy Personal login", async () => {
    const atlas = await gateway({
      api_key: "osk_browser-org.secret",
      organization_id: alpha.organization_id,
      workspace_locked: true,
      user: { user_id: "user-browser-org" },
    })
    try {
      const organization = await login()
      expect(organization).toMatchObject({
        api_key: "osk_browser-org.secret",
        user_id: "user-browser-org",
        organization_id: alpha.organization_id,
        workspace_locked: true,
      })
      expect(await OpenScience.getFundingContext()).toEqual({
        type: "organization",
        organization_id: alpha.organization_id,
        available: true,
        locked: true,
        organizations: [alpha],
      })
      expect((await OpenScience.getFundingSnapshot())?.organization_id).toBe(alpha.organization_id)
      await OpenScience.getCredits()

      await fs.mkdir(config, { recursive: true })
      await Bun.write(synced, JSON.stringify({ GITHUB_TOKEN: "old-organization-secret" }))
      await Bun.write(settings, JSON.stringify({ model: "old-organization/model" }))
      await Bun.write(queue, '{"organization_id":"org_alpha","prompt":"old"}\n')
      process.env.GITHUB_TOKEN = "old-organization-secret"

      atlas.state.reply = {
        key: "thk_legacy-personal.secret",
        user_id: "user-legacy",
      }
      const personal = await login()
      expect(personal).toMatchObject({ api_key: "thk_legacy-personal.secret", user_id: "user-legacy" })
      expect(personal.organization_id).toBeUndefined()
      expect(personal.workspace_locked).toBeUndefined()
      expect(await OpenScience.getFundingContext()).toMatchObject({ type: "personal", available: true })
      await OpenScience.getCredits()

      expect(atlas.state.starts).toHaveLength(2)
      expect(atlas.state.starts.every((start) => !("organization_id" in start))).toBe(true)
      expect(atlas.state.redeems).toHaveLength(2)
      expect(atlas.state.funded).toEqual([
        { key: "Bearer osk_browser-org.secret", organization: alpha.organization_id },
        { key: "Bearer thk_legacy-personal.secret", organization: null },
      ])
      expect(await Bun.file(synced).exists()).toBe(false)
      expect(await Bun.file(settings).exists()).toBe(false)
      expect(await Bun.file(queue).exists()).toBe(false)
      expect(process.env.GITHUB_TOKEN).toBeUndefined()
    } finally {
      await atlas.close()
    }
  })

  test("persists a new browser-approved Personal workspace as immutable", async () => {
    const atlas = await gateway({
      api_key: "thk_browser-personal.secret",
      workspace_locked: true,
      user: { user_id: "user-browser-personal" },
    })
    try {
      const personal = await login()
      expect(personal).toMatchObject({
        api_key: "thk_browser-personal.secret",
        user_id: "user-browser-personal",
        workspace_locked: true,
      })
      expect(personal.organization_id).toBeUndefined()
      expect(await OpenScience.getFundingContext()).toEqual({
        type: "personal",
        available: true,
        locked: true,
        organizations: [],
      })
      expect(await OpenScience.setFundingContext(null)).toMatchObject({ type: "personal", locked: true })
      await expect(OpenScience.setFundingContext(alpha.organization_id)).rejects.toThrow("tied to one workspace")
      expect((await Bun.file(session).json()).workspace_locked).toBe(true)
    } finally {
      await atlas.close()
    }
  })

  test("rejects a malformed organization response without replacing the active credential", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_existing.secret", user_id: "existing" }))
    const atlas = await gateway({
      api_key: "thk_invalid-org.secret",
      organization_id: "../not-an-organization",
      user: { user_id: "attacker" },
    })
    try {
      await expect(login()).rejects.toThrow("invalid organization id")
      expect(await OpenScience.getSession()).toMatchObject({ api_key: "thk_existing.secret", user_id: "existing" })
    } finally {
      await atlas.close()
    }
  })

  test("discovers a pasted organization key while old Personal-key servers remain compatible", async () => {
    const atlas = await gateway({})
    try {
      const organization = await OpenScience.loginWithKey("osk_pasted-org.secret")
      expect(organization).toMatchObject({
        api_key: "osk_pasted-org.secret",
        user_id: "user-pasted-org",
        organization_id: alpha.organization_id,
        workspace_locked: true,
      })
      expect((await OpenScience.getFundingSnapshot())?.organization_id).toBe(alpha.organization_id)

      const personal = await OpenScience.loginWithKey("thk_legacy-personal.secret")
      expect(personal).toMatchObject({ api_key: "thk_legacy-personal.secret", user_id: "user-legacy" })
      expect(personal.organization_id).toBeUndefined()
      expect((await OpenScience.getFundingSnapshot())?.organization_id).toBeUndefined()

      const locked = await OpenScience.loginWithKey("thk_pasted-personal.secret")
      expect(locked).toMatchObject({
        api_key: "thk_pasted-personal.secret",
        workspace_locked: true,
      })
      expect(locked.organization_id).toBeUndefined()
      expect(await OpenScience.getFundingContext()).toMatchObject({
        type: "personal",
        locked: true,
      })
      expect(atlas.state.syncs).toEqual([
        { key: "Bearer osk_pasted-org.secret", organization: alpha.organization_id },
        { key: "Bearer thk_legacy-personal.secret", organization: null },
        { key: "Bearer thk_pasted-personal.secret", organization: null },
      ])
    } finally {
      await atlas.close()
    }
  })

  test("keeps a pasted legacy key Personal when modern status suggests an organization", async () => {
    const atlas = await gateway({})
    try {
      const selected = await OpenScience.loginWithKey("thk_legacy-selected.secret")
      expect(selected).toMatchObject({
        api_key: "thk_legacy-selected.secret",
        user_id: "user-legacy",
      })
      expect(selected.organization_id).toBeUndefined()
      expect(selected.workspace_locked).toBeUndefined()
      expect(await OpenScience.getFundingContext()).toMatchObject({
        type: "personal",
        available: true,
        locked: false,
      })

      expect(await OpenScience.getSession()).toMatchObject({
        api_key: "thk_legacy-selected.secret",
      })
      expect((await OpenScience.getSession())?.organization_id).toBeUndefined()
      expect((await OpenScience.getSession())?.workspace_locked).toBeUndefined()

      await expect(OpenScience.setFundingContext(alpha.organization_id)).rejects.toThrow("rollback-safe")
      expect(atlas.state.syncs.length).toBeGreaterThanOrEqual(1)
      expect(atlas.state.syncs.every((call) => call.organization === null)).toBe(true)
    } finally {
      await atlas.close()
    }
  })

  test("refuses to save an organization key whose workspace cannot be verified", async () => {
    const atlas = await gateway({})
    try {
      // The key itself validates, but its immutable scope never loads. Saving
      // it anyway used to dead-end later in writeWorkspaceScope; the login
      // must fail up front with a retryable message and keep no session.
      await expect(OpenScience.loginWithKey("osk_unverified.secret")).rejects.toThrow(
        "Couldn't verify this organization key's workspace",
      )
      expect(await OpenScience.getSession()).toBeFalsy()
    } finally {
      await atlas.close()
    }
  })
})
