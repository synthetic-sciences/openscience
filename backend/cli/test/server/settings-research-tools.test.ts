import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { normalizeResearchEntitlements, OpenScience } from "../../src/openscience"
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
  test("reports signed-out Free state as conditional community search", async () => {
    restores.push(spyOn(OpenScience, "getSession").mockResolvedValue(null))
    restores.push(
      spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, signedIn: false, deletionAvailable: false }),
    )

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      signedIn: false,
      plan: { id: "free", label: "Free" },
      search: { route: "community", state: "conditional", enabled: false },
      telemetry: { analyticsEnabled: true, researchContentEnabled: false, deletionAvailable: false },
    })
  })

  test("reports normalized managed allowance and account consent", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "user_fixture" } as never),
    )
    restores.push(
      spyOn(OpenScience, "getProfile").mockResolvedValue({
        subscription_plan: "ace",
        subscription_status: "active",
      } as never),
    )
    restores.push(
      spyOn(OpenScience, "getResearchEntitlements").mockResolvedValue({
        plan: "ace",
        status: "active",
        managed_search: { enabled: true, limit: 500, used: 125, remaining: 375, reset_at: "next" },
      }),
    )
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      signedIn: true,
      plan: { id: "ace", label: "Ace", status: "active" },
      search: {
        route: "managed",
        state: "available",
        enabled: true,
        limit: 500,
        used: 125,
        remaining: 375,
        resetAt: "next",
      },
      telemetry: { source: "account", researchContentEnabled: false },
    })
  })

  test("keeps a rollout-era Free entitlement on community search", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "free_user" } as never),
    )
    restores.push(spyOn(OpenScience, "getProfile").mockResolvedValue(null))
    restores.push(
      spyOn(OpenScience, "getResearchEntitlements").mockResolvedValue(
        normalizeResearchEntitlements({
          plan: "free",
          managed_search: { enabled: true, available: false, limit: 0, used: 0, remaining: 0 },
        }),
      ),
    )
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(await response.json()).toMatchObject({
      plan: { id: "free" },
      search: { route: "community", state: "conditional", enabled: false, limit: 0 },
    })
  })
})
