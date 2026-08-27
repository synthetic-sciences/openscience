import { describe, expect, test } from "bun:test"
import {
  searchStatus,
  type ResearchToolsStatus,
  userOwnedSharingDetail,
  userOwnedSharingEnabled,
} from "./research-tools-state"

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
    userOwnedContentEnabled: true,
    source: "default",
    signedIn: true,
    consentVersion: "openscience-trace-v2-2026-08-23",
    pending: false,
    corrupt: false,
    deletionAvailable: true,
    queuedEvents: 0,
    quarantinedEvents: 0,
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

  test("discloses default-on user-owned sharing without presenting Ace as optional", () => {
    expect(userOwnedSharingEnabled(status())).toBe(true)
    expect(userOwnedSharingDetail(status())).toContain("On by default")
    const migrated = status({
      telemetry: { ...status().telemetry, userOwnedContentEnabled: false, source: "account" },
    })
    expect(userOwnedSharingEnabled(migrated)).toBe(false)
    expect(userOwnedSharingDetail(migrated)).toContain("Ace remains on")
    expect(
      userOwnedSharingEnabled(
        status({
          telemetry: { ...status().telemetry, corrupt: true },
        }),
      ),
    ).toBe(false)
    expect(
      userOwnedSharingDetail(
        status({
          telemetry: { ...status().telemetry, userOwnedContentEnabled: false, corrupt: true, source: "account" },
        }),
      ),
    ).toContain("Ace managed traces remain on")
    expect(
      userOwnedSharingDetail(
        status({
          telemetry: {
            ...status().telemetry,
            userOwnedContentEnabled: false,
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
    expect(source).toContain("researchAccessContract(option.value)")
    expect(source).toContain("projectRequest(`/project/${encodeURIComponent(project.projectID)}/access`")
    expect(source).toContain("body: JSON.stringify({ mode")
    expect(source).toContain('title: "Enable Full access?"')
    expect(source).toContain("Full access disables the execution sandbox")
    expect(source).toContain("sandboxStatus.available")
  })

  test("keeps global settings usable without a project-scoped SDK", async () => {
    const source = await Bun.file(new URL("./ResearchTools.tsx", import.meta.url)).text()
    expect(source).toContain("useGlobalSDK()")
    expect(source).toContain("resolveProjectRoute(params.dir, globalSync.data.project)")
    expect(source).toContain("Open a project to manage action approval")
    expect(source).not.toContain("useSDK()")
  })

  test("places route-aware data controls at the end of General settings", async () => {
    const source = await Bun.file(new URL("./DataUse.tsx", import.meta.url)).text()
    const stateSource = await Bun.file(new URL("./research-tools-state.ts", import.meta.url)).text()
    const general = await Bun.file(new URL("./General.tsx", import.meta.url)).text()
    const copy = source.replace(/\s+/g, " ")
    expect(copy).toContain("OpenScience Ace traces")
    expect(copy).toContain("Always on")
    expect(copy).toContain("Share user-owned routes")
    expect(stateSource).toContain("ChatGPT/Codex, provider subscriptions")
    expect(stateSource).toContain("Ace remains on")
    expect(copy).not.toContain("analyticsEnabled")
    expect(copy).toContain("queued")
    expect(general.lastIndexOf("<DataUse />")).toBeGreaterThan(general.lastIndexOf("settings-disclosure-group"))
    expect(copy).not.toContain("complete research trajectory")
    expect(copy).not.toContain("removes previously shared activity")
    expect(copy).not.toContain("Research content is never shared")
    expect(copy).not.toContain("managed searches remain")
    expect(copy).not.toContain("Delete shared data")
  })

  test("persists desktop onboarding outside random-port browser storage", async () => {
    const source = await Bun.file(new URL("../../atlas/DesktopOnboarding.tsx", import.meta.url)).text()
    const preferences = await Bun.file(
      new URL("../../../../../backend/cli/src/server/routes/settings/preferences.ts", import.meta.url),
    ).text()
    expect(source).toContain("desktop_onboarding_version")
    expect(source).toContain('settingsApi(server.url, fetcher(), "/settings/preferences"')
    expect(source).not.toContain("localStorage")
    expect(preferences).toContain("desktop_onboarding_version")
  })
})
