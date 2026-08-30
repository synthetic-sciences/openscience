import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { AccountRoutes } from "../../src/server/routes/account"

const sessionFile = path.join(Global.Path.data, "openscience-session.json")
const scopeFile = path.join(Global.Path.data, "openscience-workspace-scope.json")
const original = globalThis.fetch

describe("account.summary legacy workspace scope", () => {
  beforeEach(async () => {
    await Promise.all([fs.rm(sessionFile, { force: true }), fs.rm(scopeFile, { force: true })])
  })

  afterEach(async () => {
    globalThis.fetch = original
    await Promise.all([fs.rm(sessionFile, { force: true }), fs.rm(scopeFile, { force: true })])
  })

  test("recovers the Personal workspace Atlas assigned to a legacy key", async () => {
    await Bun.write(sessionFile, JSON.stringify({ api_key: "thk_old-organization.secret", user_id: "user-stale" }))
    const personal = {
      organization_id: "org_personal",
      name: "Personal",
      slug: "personal-user-stale",
      is_personal: true,
      status: "active",
      role: "owner",
      membership_status: "active",
      funding_available: true,
      effective_permissions: ["manage_billing", "use_shared_wallet"],
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      const payload = (() => {
        if (path === "/api/v1/auth/status") {
          return {
            api_key: { organization_id: personal.organization_id, workspace_locked: true },
            organizations: [personal],
            funding_context: { type: "organization", organization_id: personal.organization_id, locked: true },
          }
        }
        if (path === "/api/cli/sync") return { user: { user_id: "user-stale" }, services: {} }
        if (path === "/api/v1/wallet") return { balance_cents: 2_000 }
        if (path === "/api/cli/access") return { managed_supported: true, managed_unlocked: true }
        return {}
      })()
      return Response.json(payload, {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": `organization:${personal.organization_id}`,
        },
      })
    }) as typeof fetch

    const response = await AccountRoutes().request("/")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      session: true,
      balance_usd: 20,
      credential: { type: "organization", legacy: true },
      funding_context: {
        type: "organization",
        organization_id: personal.organization_id,
        available: true,
        locked: true,
        organizations: [personal],
      },
    })
    expect(await Bun.file(sessionFile).json()).toMatchObject({
      organization_id: personal.organization_id,
      workspace_locked: true,
    })
  })
})
