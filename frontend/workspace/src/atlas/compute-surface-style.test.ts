import { describe, expect, test } from "bun:test"

const [css, strip, shell] = await Promise.all([
  Bun.file(new URL("./ComputeSurface.css", import.meta.url)).text(),
  Bun.file(new URL("./HostStrip.css", import.meta.url)).text(),
  Bun.file(new URL("../styles/atlas.css", import.meta.url)).text(),
])

describe("compute tracker styling", () => {
  test("uses flat rows and dividers instead of nested cards", () => {
    expect(css).toContain(".compute-row")
    expect(css).toContain("border-bottom: 1px solid var(--color-border)")
    expect(css).toContain(".kernel-session__header")
    expect(css).toContain(".kernel-panel__other")
    expect(css).toContain(".compute-row__metric")
    expect(css).not.toContain(".activity-card")
    expect(css).not.toContain(".activity-disclosure")
    expect(css).not.toContain(".compute-guide")
    expect(css).not.toContain("box-shadow")
  })

  test("keeps the live inventory as the only scrolling content area", () => {
    expect(css).toContain(".compute-surface__panel")
    expect(css).toContain("min-height: 0")
    expect(css).toContain("overflow-y: auto")
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(strip).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  test("keeps tracker styles component-owned", () => {
    expect(shell).not.toMatch(/\.(?:compute-surface|kernel-panel|kernel-card)(?:[\s_:{.[#]|$)/)
  })

  test("keeps all three host readings permanently visible", () => {
    expect(strip).toContain("grid-template-columns:")
    expect(strip).toContain(".host-strip__metric")
    expect(strip).toContain("height: 2px")
    expect(strip).not.toContain("details")
    expect(strip).not.toContain("summary")
  })
})
