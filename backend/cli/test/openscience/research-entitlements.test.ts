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

  test("bounds managed entitlement caching and refreshes after the TTL", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_entitlement", user_id: "user_entitlement" }))
    let now = 1_000_000
    let reads = 0
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      expect(String(input).endsWith("/api/v1/entitlements")).toBe(true)
      reads++
      return Response.json({
        plan: reads === 1 ? "ace" : "free",
        managed_search: {
          enabled: true,
          available: reads === 1,
          allowance: { limit: reads === 1 ? 500 : 0, used: 0, reserved: 0, remaining: reads === 1 ? 500 : 0 },
        },
      })
    }) as typeof fetch)
    try {
      OpenScience.invalidateResearchEntitlements()
      expect((await OpenScience.getResearchEntitlements())?.managed_search?.enabled).toBe(true)
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(true)
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(true)
      expect(reads).toBe(1)

      now += 30_001
      // Routing remains account-based while the compatibility payload refreshes.
      // The server, not a retired local plan label, decides whether the Wallet
      // can fund enhanced search.
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(true)
      // A fetch invocation only proves that the request started. Authenticated
      // control-plane responses may still be finishing account reconciliation,
      // so await the coalesced public status read before observing the cache.
      expect((await OpenScience.getResearchEntitlements())?.managed_search?.enabled).toBe(false)
      expect(reads).toBe(2)
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(true)
    } finally {
      fetcher.mockRestore()
      clock.mockRestore()
    }
  })

  test("does not block account-based routing on a stalled compatibility entitlement read", async () => {
    await Bun.write(session, JSON.stringify({ api_key: "thk_stalled", user_id: "user_stalled" }))
    let release!: (value: Response) => void
    let reads = 0
    const stalled = new Promise<Response>((resolve) => {
      release = resolve
    })
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
      reads++
      return stalled
    }) as unknown as typeof fetch)
    try {
      OpenScience.invalidateResearchEntitlements()
      expect(
        await Promise.race([
          OpenScience.resolveManagedSearchEntitlement(),
          Bun.sleep(100).then(() => "timed-out" as const),
        ]),
      ).toBe(true)
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(true)
      expect(reads).toBe(0)

      const first = OpenScience.getResearchEntitlements()
      const second = OpenScience.getResearchEntitlements()
      for (let attempt = 0; reads === 0 && attempt < 50; attempt++) await Bun.sleep(1)
      expect(reads).toBe(1)
      release(Response.json({ plan: "free", managed_search: { enabled: false, limit: 0 } }))
      expect(await first).toEqual(await second)
      expect(await OpenScience.resolveManagedSearchEntitlement()).toBe(true)
    } finally {
      release(Response.json({ plan: "free", managed_search: { enabled: false, limit: 0 } }))
      fetcher.mockRestore()
    }
  })
})
