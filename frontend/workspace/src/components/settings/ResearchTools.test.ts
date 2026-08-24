import { describe, expect, test } from "bun:test"
import { dataSharingDetail, searchStatus, type ResearchToolsStatus } from "./research-tools-state"

const status = (patch?: Partial<ResearchToolsStatus>): ResearchToolsStatus => ({
  signedIn: true,
  search: {
    route: "credits",
    state: "available",
    enabled: true,
    balanceCredits: 18.75,
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
    expect(
      searchStatus(
        status({
          search: {
            ...status().search,
            route: "community",
            enabled: false,
            state: "conditional",
            balanceCredits: null,
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
            balanceCredits: null,
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
            balanceCredits: 0,
          },
        }),
      ),
    ).toMatchObject({ label: "Basic", tone: "neutral" })
  })

  test("discloses default-on sharing and corrupt-record fail-closed behavior", () => {
    expect(dataSharingDetail(status())).toContain("On by default")
    expect(
      dataSharingDetail(
        status({ telemetry: { ...status().telemetry, analyticsEnabled: false, corrupt: true, source: "account" } }),
      ),
    ).toContain("Off until")
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

  test("uses one clear data-use toggle and explains the redaction boundary", async () => {
    const source = await Bun.file(new URL("./ResearchTools.tsx", import.meta.url)).text()
    expect(source).toContain("Use my data to improve OpenScience")
    expect(source).toContain("conversations, model activity, tool runs, searches, errors, and artifact")
    expect(source).toContain("Credentials and secret values are removed before upload")
    expect(source).toContain("Turning it")
    expect(source).toContain("off removes activity previously shared")
    expect(source).not.toContain("Research content is never shared")
    expect(source).not.toContain("managed searches remain")
    expect(source).not.toContain("Delete shared data")
  })
})
