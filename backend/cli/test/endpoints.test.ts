import { describe, expect, test } from "bun:test"
import { dashboardUrl, DEFAULT_MANAGED_API_BASE, managedApiBase } from "../src/endpoints"

describe("endpoints.managedApiBase", () => {
  test("neutral default when nothing is configured", () => {
    expect(managedApiBase({})).toBe(DEFAULT_MANAGED_API_BASE)
  })

  test("default carries no internal deployment codename", () => {
    expect(DEFAULT_MANAGED_API_BASE).not.toContain("thesis-synsc")
    expect(DEFAULT_MANAGED_API_BASE).not.toContain("fly.dev")
  })

  test("SYNSC_API_BASE overrides the default", () => {
    expect(managedApiBase({ SYNSC_API_BASE: "https://local.test" })).toBe("https://local.test")
  })

  test("MANAGED_API_BASE and ATLAS_BASE_URL are honored", () => {
    expect(managedApiBase({ MANAGED_API_BASE: "https://managed.test" })).toBe("https://managed.test")
    expect(managedApiBase({ ATLAS_BASE_URL: "https://atlas.test" })).toBe("https://atlas.test")
  })

  test("SYNSC_API_BASE wins over the other aliases", () => {
    expect(
      managedApiBase({
        SYNSC_API_BASE: "https://a.test",
        MANAGED_API_BASE: "https://b.test",
        ATLAS_BASE_URL: "https://c.test",
      }),
    ).toBe("https://a.test")
    expect(managedApiBase({ OPENSCIENCE_API_BASE: "https://n.test" })).toBe("https://n.test")
    expect(
      managedApiBase({
        OPENSCIENCE_API_BASE: "https://n.test",
        SYNSC_API_BASE: "https://a.test",
      }),
    ).toBe("https://n.test")
  })

  test("trailing slashes are stripped", () => {
    expect(managedApiBase({ SYNSC_API_BASE: "https://x.test/" })).toBe("https://x.test")
    expect(managedApiBase({ SYNSC_API_BASE: "https://x.test///" })).toBe("https://x.test")
  })
})

describe("endpoints.dashboardUrl", () => {
  test("defaults to the unified production dashboard", () => {
    expect(dashboardUrl("/billing", {})).toBe("https://app.syntheticsciences.ai/billing")
  })

  test("keeps staging and self-host frontend overrides", () => {
    expect(dashboardUrl("/billing", { SYNSC_AUTH_URL: "https://staging.example/cli" })).toBe(
      "https://staging.example/billing",
    )
    expect(dashboardUrl("/billing", { OPENSCIENCE_API_BASE: "https://self-hosted.example/api" })).toBe(
      "https://self-hosted.example/billing",
    )
  })

  test("falls back safely when the configured frontend is invalid", () => {
    expect(dashboardUrl("/billing", { SYNSC_AUTH_URL: "://bad" })).toBe("https://app.syntheticsciences.ai/billing")
  })
})
