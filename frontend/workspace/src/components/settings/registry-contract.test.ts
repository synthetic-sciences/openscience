import { describe, expect, test } from "bun:test"
import { SETTINGS_PANELS, SETTINGS_PANEL_IDS, SETTINGS_SECTIONS } from "./registry"

const root = new URL("./", import.meta.url)
const modules: Record<(typeof SETTINGS_PANEL_IDS)[number], string> = {
  models: "Models",
  "local-models": "LocalModels",
  skills: "Skills",
  "scientific-tools": "ScientificTools",
  connectors: "Connectors",
  "research-tools": "ResearchTools",
  compute: "Compute",
  network: "Network",
  permissions: "Permissions",
  sandbox: "Sandbox",
  credentials: "Credentials",
  storage: "Storage",
  general: "General",
}

describe("settings registry source contract", () => {
  test("enumerates every reachable panel once and in rail order", () => {
    expect(SETTINGS_PANELS.map((panel) => panel.id)).toEqual([...SETTINGS_PANEL_IDS])
    expect(new Set(SETTINGS_PANELS.map((panel) => panel.id)).size).toBe(SETTINGS_PANEL_IDS.length)

    for (const section of SETTINGS_SECTIONS) {
      expect(
        SETTINGS_PANELS.some((panel) => panel.section === section.id),
        section.id,
      ).toBe(true)
    }
  })

  test("keeps every destination visible in the grouped rail", () => {
    expect(SETTINGS_PANELS.map((panel) => panel.title)).toEqual([
      "Models",
      "Local models",
      "Skills",
      "Scientific tools",
      "MCP & connectors",
      "Research tools",
      "Compute",
      "Security & access",
      "Network",
      "Sandbox",
      "Credentials",
      "Storage",
      "General",
    ])
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual(["Inference", "Capabilities", "Runtime", "App"])
    expect(SETTINGS_PANELS.every((panel) => "parent" in panel === false)).toBe(true)
  })

  test("keeps every panel inside the shared settings frame", async () => {
    for (const id of SETTINGS_PANEL_IDS) {
      const source = await Bun.file(new URL(`${modules[id]}.tsx`, root)).text()
      if (id === "skills") {
        expect(source, id).toContain("<SkillsFrame>")
        continue
      }
      expect(source, id).toContain("<PanelScroll>")
      expect(source, id).toContain("<PanelHeader")
      expect(source, id).toContain("<PanelBody>")
    }
  })

  test("keeps nested model and general surfaces in the audited source set", async () => {
    const models = await Bun.file(new URL("Models.tsx", root)).text()
    const general = await Bun.file(new URL("General.tsx", root)).text()

    expect(models).toContain("<ManagedInference")
    expect(models).toContain("<CodexConnection")
    expect(models).toContain("<ProviderKeys")
    expect(general).toContain("<AppearanceSections")
    expect(general).not.toContain('title="Navigation"')
    expect(general).not.toContain('title="Gateway"')
    expect(general).not.toContain('title="Trace"')
    expect(general).not.toContain("atlas_enabled")
    expect(general).not.toContain("show_trace")
  })

  test("keeps specialist and memory implementations unavailable from the settings surface", () => {
    expect(SETTINGS_PANEL_IDS).not.toContain("specialists" as never)
    expect(SETTINGS_PANEL_IDS).not.toContain("memory" as never)
    expect(SETTINGS_PANELS.map((panel) => panel.title)).not.toContain("Specialists")
    expect(SETTINGS_PANELS.map((panel) => panel.title)).not.toContain("Memory")
  })
})
