import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import { ResearchToolsSettingsRoutes } from "../../src/server/routes/settings/research-tools"
import { OutboundTelemetry } from "../../src/telemetry/outbound"

const restores: Array<{ mockRestore(): void }> = []

afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore()
})

const telemetry = {
  analyticsEnabled: true,
  researchContentEnabled: false as const,
  source: "default" as const,
  signedIn: true,
  consentVersion: "openscience-analytics-2026-08-20",
  pending: false,
  corrupt: false,
  deletionAvailable: true,
}

describe("research tools settings route", () => {
  test("reports signed-out PAYG state with community search", async () => {
    restores.push(spyOn(OpenScience, "getSession").mockResolvedValue(null))
    restores.push(
      spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, signedIn: false, deletionAvailable: false }),
    )

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      signedIn: false,
      wallet: { mode: "payg", balanceUsd: null },
      search: { route: "community", enhancedAvailable: false },
      telemetry: { analyticsEnabled: true, researchContentEnabled: false, deletionAvailable: false },
    })
  })

  test("reports wallet balance and enhanced search for any signed-in account", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "user_fixture" } as never),
    )
    restores.push(spyOn(OpenScience, "getBalance").mockResolvedValue(23.45))
    const legacyEntitlements = spyOn(OpenScience, "getResearchEntitlements")
    restores.push(legacyEntitlements)
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      signedIn: true,
      wallet: { mode: "payg", balanceUsd: 23.45 },
      search: { route: "enhanced", enhancedAvailable: true },
      telemetry: { source: "account", researchContentEnabled: false },
    })
    expect(legacyEntitlements).not.toHaveBeenCalled()
  })

  test("does not expose legacy plan or allowance fields on the public wire", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "legacy_user" } as never),
    )
    restores.push(spyOn(OpenScience, "getBalance").mockResolvedValue(0))
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    const body = await response.json()
    expect(body).toMatchObject({ wallet: { mode: "payg", balanceUsd: 0 }, search: { route: "enhanced" } })
    expect(body).not.toHaveProperty("plan")
    for (const key of ["limit", "used", "remaining", "resetAt"]) expect(body.search).not.toHaveProperty(key)
  })

  test("keeps the checked-in OpenAPI and SDK on the PAYG search contract", async () => {
    const openapi = await Bun.file(new URL("../../../../tooling/sdk/openapi.json", import.meta.url)).json()
    const route = openapi.paths["/settings/research-tools"]
    const telemetryRoute = openapi.paths["/settings/research-tools/telemetry"]
    const sdk = await Bun.file(new URL("../../../../tooling/sdk/js/src/v2/gen/types.gen.ts", import.meta.url)).text()
    const published = JSON.stringify([route, telemetryRoute])

    expect(route.get.summary).toBe("Get wallet, enhanced-search, and data-sharing status")
    expect(published).toContain('"const":"payg"')
    expect(published).toContain('"enhancedAvailable"')
    for (const retired of ["plan", "limit", "used", "remaining", "resetAt", "communityFlagEnabled"]) {
      expect(published).not.toContain(`"${retired}"`)
    }
    expect(sdk).toContain('mode: "payg"')
    expect(sdk).toContain('route: "enhanced" | "community"')
    expect(sdk).not.toContain("communityFlagEnabled")
  })
})
