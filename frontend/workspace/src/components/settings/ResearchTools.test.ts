import { describe, expect, test } from "bun:test"
import { dataSharingDetail, searchStatus, walletStatus, type ResearchToolsStatus } from "./research-tools-state"

const status = (patch?: Partial<ResearchToolsStatus>): ResearchToolsStatus => ({
  signedIn: true,
  wallet: { mode: "payg", balanceUsd: 23.45 },
  search: {
    route: "enhanced",
    enhancedAvailable: true,
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
  test("summarizes wallet-backed enhanced search and the community fallback", () => {
    expect(searchStatus(status())).toMatchObject({ label: "Enhanced", tone: "success" })
    expect(walletStatus(status())).toMatchObject({ label: "$23.45 available", tone: "success" })
    expect(
      searchStatus(
        status({
          search: {
            ...status().search,
            route: "community",
            enhancedAvailable: false,
          },
        }),
      ),
    ).toMatchObject({ label: "Community", tone: "neutral" })
    expect(walletStatus(status({ signedIn: false, wallet: { mode: "payg", balanceUsd: null } }))).toMatchObject({
      label: "Not connected",
      tone: "neutral",
    })
    expect(walletStatus(status({ wallet: { mode: "payg", balanceUsd: -1 } }))).toMatchObject({
      label: "$-1.00 balance",
      tone: "warning",
    })
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

  test("shows PAYG wallet and search status without retired plan or quota copy", async () => {
    const sources = await Promise.all(
      ["ResearchTools.tsx", "research-tools-state.ts", "General.tsx"].map((file) =>
        Bun.file(new URL(`./${file}`, import.meta.url)).text(),
      ),
    )
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:Ace\+?|Legacy Pro|Legacy Starter|subscription|search allowance|Manage plan)\b/i)
    }
    expect(sources[0]).toContain("Usage is pay as you go")
    expect(sources[0]).toContain("Open billing")
  })
})
