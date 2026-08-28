import { describe, expect, test } from "bun:test"

const publicSources = [
  "../pages/session-sidebar-action.tsx",
  "../pages/session.tsx",
  "../pages/home-workbench.tsx",
  "../pages/home.tsx",
  "../atlas/SetupDialog.tsx",
  "../atlas/AccountGate.tsx",
  "../atlas/RightPane.tsx",
  "../atlas/AtlasCanvas.tsx",
  "../atlas/kernel-runtime.ts",
  "../atlas/SessionTraceSurface.tsx",
  "../i18n/zh.ts",
  "./settings/General.tsx",
  "./settings/ProviderKeys.tsx",
  "./settings/ResearchTools.tsx",
] as const

function renderedSource(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import\s.*$/gm, "")
}

describe("public Synthetic Sciences branding", () => {
  test("retains internal Atlas component names without rendering the old standalone brand", async () => {
    const violations: string[] = []
    for (const file of publicSources) {
      const source = renderedSource(await Bun.file(new URL(file, import.meta.url)).text())
      if (/\bAtlas\b/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })

  test("does not render Gateway as the Synthetic Sciences product name", async () => {
    const violations: string[] = []
    for (const file of publicSources) {
      const source = renderedSource(await Bun.file(new URL(file, import.meta.url)).text()).replaceAll("AI Gateway", "")
      if (/\bGateway\b/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })

  test("uses Synthetic Sciences for managed login and account branding", async () => {
    const sources = await Promise.all(
      [
        "../atlas/SetupDialog.tsx",
        "../atlas/AccountGate.tsx",
        "./settings/General.tsx",
        "./settings/ManagedInference.tsx",
        "./settings/ProviderKeys.tsx",
        "./settings/ResearchTools.tsx",
      ].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
    )
    const combined = sources.join("\n")

    expect(combined).toContain("Synthetic Sciences account")
    expect(combined).toContain("Ace wallet")
    expect(combined).toContain('title: "Managed"')
    expect(combined).toContain("Use your Ace balance")
    expect(combined).not.toContain("Add Ace credits")
    expect(combined).toContain("Connected to Synthetic Sciences")
    expect(combined).toContain("openscience login")
    expect(combined).not.toMatch(/OpenScience (?:account|identity|credits|plan)/)
    expect(combined).not.toMatch(/(?:Sign in to|Connected to) Gateway/)
    expect(combined).not.toContain("openscience connect login")
  })
})
