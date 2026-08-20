import { describe, expect, test } from "bun:test"

const publicSources = [
  "../pages/session-sidebar-action.tsx",
  "../pages/session.tsx",
  "../pages/home-workbench.tsx",
  "../pages/home.tsx",
  "../atlas/SetupDialog.tsx",
  "../atlas/RightPane.tsx",
  "../atlas/AtlasCanvas.tsx",
  "../atlas/kernel-runtime.ts",
  "../atlas/SessionTraceSurface.tsx",
  "./settings/General.tsx",
  "./settings/ProviderKeys.tsx",
] as const

function renderedSource(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import\s.*$/gm, "")
}

describe("public Gateway branding allowlist", () => {
  test("retains internal Atlas component names without rendering the old standalone brand", async () => {
    const violations: string[] = []
    for (const file of publicSources) {
      const source = renderedSource(await Bun.file(new URL(file, import.meta.url)).text())
      if (/\bAtlas\b/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })
})
