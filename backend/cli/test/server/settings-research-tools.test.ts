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
  researchContentEnabled: true,
  source: "default" as const,
  signedIn: true,
  consentVersion: "openscience-trace-v2-2026-08-23",
  pending: false,
  corrupt: false,
  deletionAvailable: true,
}

describe("research tools settings route", () => {
  test("reports signed-out state as conditional community search", async () => {
    restores.push(spyOn(OpenScience, "getSession").mockResolvedValue(null))
    restores.push(
      spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, signedIn: false, deletionAvailable: false }),
    )

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      signedIn: false,
      plan: { id: "credits", label: "Credits", status: null },
      search: {
        route: "community",
        state: "conditional",
        enabled: false,
        limit: null,
        used: null,
        remaining: null,
        resetAt: null,
      },
      telemetry: { analyticsEnabled: true, researchContentEnabled: true, deletionAvailable: false },
    })
  })

  test("reports the shared Ace credit balance and account consent", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "user_fixture" } as never),
    )
    restores.push(spyOn(OpenScience, "getBalance").mockResolvedValue(18.75))
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      signedIn: true,
      plan: { id: "credits", label: "Credits", status: "active" },
      search: {
        route: "credits",
        state: "available",
        enabled: true,
        balanceUsd: 18.75,
        limit: null,
        used: null,
        remaining: null,
        resetAt: null,
      },
      telemetry: { source: "account", researchContentEnabled: true },
    })
  })

  test("keeps basic search available with an empty Wallet and no separate quota", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "free_user" } as never),
    )
    restores.push(spyOn(OpenScience, "getBalance").mockResolvedValue(0))
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(await response.json()).toMatchObject({
      search: { route: "credits", state: "basic", enabled: true, balanceUsd: 0 },
    })
  })

  test("keeps community search available when the enhanced balance check fails", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "offline_user" } as never),
    )
    restores.push(spyOn(OpenScience, "getBalance").mockRejectedValue(new Error("temporarily offline")))
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(await response.json()).toMatchObject({
      search: { route: "credits", state: "basic", enabled: true, balanceUsd: null },
    })
  })

  test("keeps basic search available when adjustments leave the Wallet negative", async () => {
    restores.push(
      spyOn(OpenScience, "getSession").mockResolvedValue({ api_key: "thk_fixture", user_id: "adjusted_user" } as never),
    )
    restores.push(spyOn(OpenScience, "getBalance").mockResolvedValue(-0.25))
    restores.push(spyOn(OutboundTelemetry, "status").mockResolvedValue({ ...telemetry, source: "account" }))

    const response = await ResearchToolsSettingsRoutes().request("/")
    expect(await response.json()).toMatchObject({
      search: { route: "credits", state: "basic", enabled: true, balanceUsd: -0.25 },
    })
  })
})
