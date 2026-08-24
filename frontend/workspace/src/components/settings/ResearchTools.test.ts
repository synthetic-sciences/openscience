import { describe, expect, test } from "bun:test"
import { dataSharingDetail, dataSharingEnabled, searchStatus, type ResearchToolsStatus } from "./research-tools-state"

const status = (patch?: Partial<ResearchToolsStatus>): ResearchToolsStatus => ({
  signedIn: true,
  search: {
    route: "credits",
    state: "available",
    enabled: true,
    balanceUsd: 18.75,
    communityFlagEnabled: false,
  },
  telemetry: {
    analyticsEnabled: true,
    researchContentEnabled: true,
    source: "default",
    signedIn: true,
    consentVersion: "openscience-trace-v2-2026-08-23",
    pending: false,
    corrupt: false,
    deletionAvailable: true,
  },
  ...patch,
})

describe("Research Tools settings", () => {
  test("summarizes shared-credit and community search without inventing an allowance", () => {
    expect(searchStatus(status())).toMatchObject({ label: "Ready", tone: "success" })
    expect(searchStatus(status()).detail).toBe("$18.75 available for credit-backed models and enhanced search.")
    expect(
      searchStatus(
        status({
          search: {
            ...status().search,
            route: "community",
            enabled: false,
            state: "conditional",
            balanceUsd: null,
          },
        }),
      ),
    ).toMatchObject({ label: "Community", tone: "neutral" })

    expect(
      searchStatus(
        status({
          search: {
            ...status().search,
            state: "basic",
            balanceUsd: null,
          },
        }),
      ),
    ).toMatchObject({
      label: "Basic",
      detail: "Basic community search is available. Enhanced search status could not be checked.",
      tone: "neutral",
    })

    expect(
      searchStatus(
        status({
          search: {
            ...status().search,
            state: "basic",
            balanceUsd: 0,
          },
        }),
      ),
    ).toMatchObject({ label: "Basic", tone: "neutral" })
  })

  test("discloses default-on sharing and corrupt-record fail-closed behavior", () => {
    expect(dataSharingEnabled(status())).toBe(true)
    expect(dataSharingDetail(status())).toContain("On by default")
    const migrated = status({
      telemetry: { ...status().telemetry, analyticsEnabled: true, researchContentEnabled: false, source: "account" },
    })
    expect(dataSharingEnabled(migrated)).toBe(false)
    expect(dataSharingDetail(migrated)).toBe("Off. New activity is not shared.")
    expect(
      dataSharingEnabled(
        status({
          telemetry: { ...status().telemetry, analyticsEnabled: true, researchContentEnabled: true, corrupt: true },
        }),
      ),
    ).toBe(false)
    expect(
      dataSharingDetail(
        status({ telemetry: { ...status().telemetry, analyticsEnabled: false, corrupt: true, source: "account" } }),
      ),
    ).toContain("Off until")
    expect(
      dataSharingDetail(
        status({
          telemetry: {
            ...status().telemetry,
            analyticsEnabled: false,
            researchContentEnabled: false,
            pending: true,
            source: "account",
          },
        }),
      ),
    ).toContain("setting will sync when OpenScience reconnects")
  })

  test("wires the real trust and sandbox contracts and warns before Full access", async () => {
    const source = await Bun.file(new URL("./ResearchTools.tsx", import.meta.url)).text()
    expect(source).toContain("RESEARCH_ACCESS_OPTIONS")
    expect(source).toContain("researchAccessMutations(mode)")
    expect(source).toContain("sdk.client.project.trust.update")
    expect(source).toContain('projectRequest("/settings/sandbox"')
    expect(source).toContain('title: "Enable Full access?"')
    expect(source).toContain("Full access disables the execution sandbox")
    expect(source).toContain("sandboxAvailable")
  })

  test("keeps global settings usable without a project-scoped SDK", async () => {
    const source = await Bun.file(new URL("./ResearchTools.tsx", import.meta.url)).text()
    expect(source).toContain("useGlobalSDK()")
    expect(source).toContain("resolveProjectRoute(params.dir, globalSync.data.project)")
    expect(source).toContain("Open a project to manage action approval")
    expect(source).not.toContain("useSDK()")
  })

  test("uses one clear prospective data-use toggle", async () => {
    const source = await Bun.file(new URL("./ResearchTools.tsx", import.meta.url)).text()
    const copy = source.replace(/\s+/g, " ")
    expect(copy).toContain("Use my data to improve OpenScience")
    expect(copy).not.toContain("complete research trajectory")
    expect(copy).not.toContain("removes previously shared activity")
    expect(copy).not.toContain("Research content is never shared")
    expect(copy).not.toContain("managed searches remain")
    expect(copy).not.toContain("Delete shared data")
  })
})
