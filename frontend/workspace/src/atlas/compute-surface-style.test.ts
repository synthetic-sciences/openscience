import { describe, expect, test } from "bun:test"

const [css, strip, shell] = await Promise.all([
  Bun.file(new URL("./ComputeSurface.css", import.meta.url)).text(),
  Bun.file(new URL("./HostStrip.css", import.meta.url)).text(),
  Bun.file(new URL("../styles/atlas.css", import.meta.url)).text(),
])

describe("compute surface styling", () => {
  test("uses a quiet operational ledger instead of a card dashboard", () => {
    expect(css).toContain(".compute-surface .kernel-card")
    expect(css).toContain("border-radius: var(--compute-radius-card)")
    expect(css).toContain("box-shadow: none")
    expect(css).not.toContain(".compute-surface__atlas")
    expect(css).toContain("gap: 4px")
    expect(css).toContain("transition: background-color 140ms ease")
    expect(css).toContain(".remote-job-card__actions button:focus-visible")
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

  test("keeps compute styling component-owned instead of layering legacy shell overrides", () => {
    expect(shell).not.toMatch(/\.(?:compute-surface|kernel-panel|kernel-card)(?:[\s_:{.[#]|$)/)
  })
})
