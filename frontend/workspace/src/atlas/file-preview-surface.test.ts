import { describe, expect, test } from "bun:test"

const css = await Bun.file(new URL("./FilePreview.css", import.meta.url)).text()

describe("file preview surface", () => {
  test("uses one compact operational toolbar", () => {
    expect(css).toContain("min-height: 48px")
    expect(css).toContain("font-size: 14px")
    expect(css).toContain("font-size: 11px")
    expect(css).toContain("min-height: 32px")
    expect(css).toContain("border-radius: var(--atlas-radius-sm)")
    expect(css).toContain("border-radius: var(--atlas-radius-xs)")
  })

  test("keeps documents readable without presentation-scale spacing", () => {
    expect(css).toContain("width: min(100%, 820px)")
    expect(css).toContain("font-size: 15px")
    expect(css).toContain("font-size: 13px")
    expect(css).toContain("padding: clamp(30px, 5cqi, 52px)")
  })

  test("keeps loading and segmented controls calm across host surfaces", () => {
    expect(css).not.toContain("linear-gradient")
    expect(css).not.toMatch(/border-radius:\s*(?:7|8|9|10)px/)
    expect(css).toContain("background: var(--color-bg-subtle)")
  })

  test("keeps the preview chrome seamless and touch targets reachable", () => {
    expect(css).toMatch(/\.atlas-file-toolbar\s*\{[^}]*border-bottom: 1px solid/s)
    expect(css).toMatch(/\.atlas-file-modes\s*\{[^}]*border: 0;/s)
    expect(css).toMatch(/\.atlas-file-button,\s*\.atlas-file-action\s*\{[^}]*border: 0;/s)
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/)
  })

  test("responds to the resizable pane and gives complex previews their own scroller", () => {
    expect(css).toContain("container: atlas-file-view / inline-size")
    expect(css).toContain("@container atlas-file-view (max-width: 760px)")
    expect(css).toMatch(/\.atlas-file-scroll\.is-managed-scroll,[\s\S]*overflow: hidden/s)
    expect(css).toMatch(/\.atlas-file-pdf\s*\{[^}]*flex: 1/s)
    expect(css).toMatch(/\.atlas-file-pdf \.pdf-viewer\s*\{[^}]*height: 100%/s)
  })
})
