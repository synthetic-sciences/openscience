import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { AccountRoutes } from "../../src/server/routes/account"

const sessionFile = path.join(Global.Path.data, "openscience-session.json")
const scopeFile = path.join(Global.Path.data, "openscience-workspace-scope.json")
const original = globalThis.fetch

describe("account.summary stale workspace scope", () => {
  beforeEach(async () => {
    await Promise.all([fs.rm(sessionFile, { force: true }), fs.rm(scopeFile, { force: true })])
  })

  afterEach(async () => {
    globalThis.fetch = original
    await Promise.all([fs.rm(sessionFile, { force: true }), fs.rm(scopeFile, { force: true })])
  })

  test("degrades to an unavailable funding context instead of a 500", async () => {
    // A legacy key the gateway has since pinned to an organization makes the
    // funding reconciliation throw. The summary must still answer with the
    // session so Settings can offer a fresh sign-in.
    await Bun.write(sessionFile, JSON.stringify({ api_key: "thk_old-organization.secret", user_id: "user-stale" }))
    globalThis.fetch = (async () =>
      Response.json(
        {
          api_key: { organization_id: "org_alpha", workspace_locked: true },
          organizations: [],
          funding_context: { type: "organization", organization_id: "org_alpha", locked: true },
        },
        {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": "organization:org_alpha",
          },
        },
      )) as unknown as typeof fetch

    const response = await AccountRoutes().request("/")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      session: true,
      balance_usd: null,
      billing_mode: null,
      funding_context: {
        type: "personal",
        available: false,
        locked: false,
        organizations: [],
      },
    })
  })
})
