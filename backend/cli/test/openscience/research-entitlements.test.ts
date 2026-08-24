import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { normalizeResearchEntitlements, OpenScience } from "../../src/openscience"

const session = path.join(Global.Path.data, "openscience-session.json")

afterEach(async () => {
  OpenScience.invalidateResearchEntitlements()
  await fs.rm(session, { force: true })
})

describe("research entitlement rollout compatibility", () => {
  test("keeps the flat alias shape", () => {
    expect(
      normalizeResearchEntitlements({
        plan: "ace",
        managed_search: { enabled: true, limit: 500, used: 10, reserved: 2, remaining: 488, reset_at: "next" },
      }).managed_search,
    ).toMatchObject({ enabled: true, limit: 500, used: 10, reserved: 2, remaining: 488, reset_at: "next" })
  })

  test("normalizes the deployed available plus nested allowance shape", () => {
    expect(
      normalizeResearchEntitlements({
        plan: "ace_plus",
        managed_search: {
          available: true,
          allowance: { limit: 2_000, used: 1_100, reserved: 3, remaining: 897, reset_at: "next" },
        },
      }).managed_search,
    ).toMatchObject({ enabled: true, limit: 2_000, used: 1_100, reserved: 3, remaining: 897, reset_at: "next" })
  })

  test("prefers account availability when an older Free response reports provider readiness as enabled", () => {
    expect(
      normalizeResearchEntitlements({
        plan: "free",
        managed_search: { enabled: true, available: false, allowance: { limit: 0 }, limit: 0 },
      }).managed_search,
    ).toMatchObject({ enabled: false, limit: 0 })
  })

  test("authenticated routing ignores legacy plan and allowance decisions", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_entitlement", user_id: "user_entitlement" }))
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      expect(String(input).endsWith("/api/v1/entitlements")).toBe(true)
      return Response.json({
        plan: "free",
        managed_search: {
          enabled: false,
          available: false,
          allowance: { limit: 0, used: 0, reserved: 0, remaining: 0 },
        },
      })
    }) as typeof fetch)
    try {
      OpenScience.invalidateResearchEntitlements()
      expect((await OpenScience.getResearchEntitlements())?.managed_search?.enabled).toBe(false)
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(true)
    } finally {
      fetcher.mockRestore()
    }
  })

  test("signed-out routing uses basic search without reading entitlements", async () => {
    const fetcher = spyOn(globalThis, "fetch")
    try {
      OpenScience.invalidateResearchEntitlements()
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(false)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })
})
