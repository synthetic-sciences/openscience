import { describe, expect, test } from "bun:test"

const [css, strip, shell] = await Promise.all([
  Bun.file(new URL("./ComputeSurface.css", import.meta.url)).text(),
  Bun.file(new URL("./HostStrip.css", import.meta.url)).text(),
  Bun.file(new URL("../styles/atlas.css", import.meta.url)).text(),
])

describe("activity surface styling", () => {
  test("uses a quiet result ledger with progressive disclosure", () => {
    expect(css).toContain(".compute-surface .activity-card")
    expect(css).toContain(".compute-surface .activity-disclosure")
    expect(css).toContain(".compute-surface .activity-card__facts")
    expect(css).toContain("border-radius: 11px")
    expect(css).toContain("border: 0")
    expect(css).not.toContain(".compute-surface__atlas")
    expect(css).toContain("gap: 4px")
    expect(css).toContain("background-color 140ms ease")
    expect(css).toContain(".activity-disclosure > summary:focus-visible")
    expect(css).toContain("font-weight: var(--font-weight-medium)")
    expect(strip).toContain("height: 2px")
    expect(css).not.toContain(".compute-surface__tabs")
  })

  test("keeps the live inventory as the only scrolling content area", () => {
    expect(css).toContain(".compute-surface__panel")
    expect(css).toContain("min-height: 0")
    expect(css).toContain("overflow-y: auto")
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(strip).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  test("keeps activity styling component-owned instead of layering legacy shell overrides", () => {
    expect(shell).not.toMatch(/\.(?:compute-surface|kernel-panel|kernel-card)(?:[\s_:{.[#]|$)/)
  })

  test("keeps capacity telemetry legible at the narrowest supported pane width", () => {
    expect(css).toContain(".activity-surface__capacity-title-prefix")
    expect(css).toContain(".activity-surface__capacity-reading small")
    expect(css).toContain("font-size: 11px")
    expect(css).not.toMatch(
      /\.activity-surface__capacity-reading small,\s*\.activity-surface__capacity-reading strong\s*\{\s*font-size:\s*10px/,
    )
  })
})
