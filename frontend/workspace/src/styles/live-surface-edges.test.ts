import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("live workbench edge geometry", () => {
  test("uses the workspace radius ladder and keeps live surfaces free of decorative gradients", async () => {
    const [home, terminal, sidebar, atlas] = await Promise.all([
      read("../pages/home-workbench.css"),
      read("../atlas/TerminalSurface.css"),
      read("../pages/session-sidebar.css"),
      read("./atlas.css"),
    ])
    const liveSurfaces = [home, terminal]

    for (const css of liveSurfaces) {
      expect(css).toContain("border-radius: var(--atlas-radius-")
      expect(css).not.toMatch(/border-radius:\s*\d+(?:\.\d+)?px\b/)
      expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\(/)
    }

    expect(home).toContain("border-radius: 50%")
    expect(sidebar).toMatch(
      /\.session-sidebar\s*\{[^}]*border: 0;[^}]*border-right: 1px solid color-mix\(in srgb, var\(--color-border\) 60%, transparent\);[^}]*border-radius: 0;[^}]*background: color-mix\(in srgb, var\(--color-bg-subtle\) 88%, var\(--color-bg\)\);/s,
    )
    expect(sidebar).toMatch(
      /@media \(max-width: 719px\)[\s\S]*\.session-sidebar\s*\{[^}]*border: 1px solid color-mix\(in srgb, var\(--color-border-strong\) 62%, transparent\);[^}]*border-radius: var\(--atlas-radius-sm\);/,
    )
    expect(sidebar).toMatch(
      /\.session-sidebar-backdrop\s*\{[^}]*background: color-mix\(in srgb, var\(--color-bg\) 68%, transparent\);/s,
    )
    expect(sidebar).not.toContain("color-mix(in srgb, var(--color-bg-subtle) 54%, var(--color-bg))")
    expect(sidebar).not.toContain("color-mix(in srgb, var(--color-bg) 62%, transparent)")
    expect(atlas).not.toContain(".terminal-surface")
    expect(atlas).toMatch(/\.g-composer\s*\{[^}]*border-radius: var\(--atlas-radius-md\);/s)
    expect(atlas).toMatch(
      /\.atlas-rn\s*\{[^}]*background: var\(--color-surface-solid\);[^}]*border-radius: var\(--atlas-radius-xs\);/s,
    )
    expect(atlas.match(/border-radius:\s*\d+(?:\.\d+)?px\b/g)).toEqual(["border-radius: 4px"])
    expect(atlas).toMatch(
      /\.atlas-scroll::-webkit-scrollbar-thumb\s*\{[^}]*Deliberate micro-geometry:[^}]*border-radius: 4px;/s,
    )
  })
})
