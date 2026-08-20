import { describe, expect, test } from "bun:test"
import { dataSharingDetail, searchStatus, type ResearchToolsStatus } from "./research-tools-state"

const status = (patch?: Partial<ResearchToolsStatus>): ResearchToolsStatus => ({
  signedIn: true,
  plan: { id: "ace", label: "Ace", status: "active" },
  search: {
    route: "managed",
    state: "available",
    enabled: true,
    limit: 500,
    used: 125,
    remaining: 375,
    resetAt: "2026-09-01T00:00:00.000Z",
    communityFlagEnabled: false,
  },
  telemetry: {
    analyticsEnabled: true,
    researchContentEnabled: false,
    source: "default",
    signedIn: true,
    consentVersion: "openscience-analytics-2026-08-20",
    pending: false,
    corrupt: false,
    deletionAvailable: true,
  },
  ...patch,
})

describe("Research Tools settings", () => {
  test("summarizes managed and community search without inventing an allowance", () => {
    expect(searchStatus(status())).toMatchObject({ label: "375 left", tone: "success" })
    expect(
      searchStatus(
        status({
          search: {
            ...status().search,
            route: "community",
            enabled: false,
            state: "conditional",
            limit: null,
            used: null,
            remaining: null,
            resetAt: null,
          },
        }),
      ),
    ).toMatchObject({ label: "Community", tone: "neutral" })

    expect(
      searchStatus(
        status({
          search: {
            ...status().search,
            state: "unavailable",
            limit: null,
            used: null,
            remaining: null,
          },
        }),
      ),
    ).toMatchObject({ label: "Allowance unavailable", tone: "neutral" })
  })

  test("discloses default-on sharing and corrupt-record fail-closed behavior", () => {
    expect(dataSharingDetail(status())).toContain("On by default")
    expect(
      dataSharingDetail(
        status({ telemetry: { ...status().telemetry, analyticsEnabled: false, corrupt: true, source: "local" } }),
      ),
    ).toContain("sharing is off")
  })

  test("wires the real trust and sandbox contracts and warns before Full access", async () => {
    const source = await Bun.file(new URL("./ResearchTools.tsx", import.meta.url)).text()
    expect(source).toContain("RESEARCH_ACCESS_OPTIONS")
    expect(source).toContain("researchAccessMutations(mode)")
    expect(source).toContain("sdk.client.project.trust.update")
    expect(source).toContain('sdk.request("/settings/sandbox"')
    expect(source).toContain('title: "Enable Full access?"')
    expect(source).toContain("Full access disables the execution sandbox")
    expect(source).toContain("sandboxAvailable")
  })

  test("states the content exclusion boundary next to the sharing switch", async () => {
    const source = await Bun.file(new URL("./ResearchTools.tsx", import.meta.url)).text()
    expect(source).toContain("Research content is never shared")
    expect(source).toContain("Prompts, responses, tool inputs and outputs")
    expect(source).toContain("separate from the local session trace and billing")
    expect(source).toContain('method: "DELETE"')
  })
})
