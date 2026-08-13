import { describe, expect, test } from "bun:test"

const css = await Bun.file(new URL("./connectors.css", import.meta.url)).text()
const source = await Bun.file(new URL("./Connectors.tsx", import.meta.url)).text()

describe("Connectors settings visual contract", () => {
  test("uses the compact neutral workspace control language", () => {
    expect(css).toContain("--connectors-control-height: 32px")
    expect(css).toContain("background: var(--settings-primary)")
    expect(css).toContain("border: 1px solid var(--border-weak-base)")
    expect(css).not.toContain('[data-slot="switch-control"]')
    expect(css).not.toMatch(/#(?:007aff|0a84ff|0066d6|409cff)/i)
  })

  test("keeps identity, status, and row actions in stable aligned columns", () => {
    expect(css).toContain("--connectors-row-columns: 32px minmax(180px, 1fr) minmax(92px, auto) auto")
    expect(css).toContain("grid-template-columns: var(--connectors-row-columns)")
    expect(source).toContain('class="connectors-status" data-tone={dot(s())}')
    expect(source).toContain("const identity = connectorIdentity(name, config)")
  })

  test("preserves every connector operation with advanced actions disclosed in details", () => {
    expect(source).toContain("void authenticate(name)")
    expect(source).toContain("void disconnectAuth(name)")
    expect(source).toContain("editConnector(name, config)")
    expect(source).toContain("void remove(name)")
    expect(source).toContain("void toggle(name, v)")
    expect(source).toContain("<ConnectorInspection detail={detail()} />")
  })

  test("expands hit areas for touch without enlarging desktop controls", () => {
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*\.connectors-panel \[data-component="switch"\]/)
    expect(css).toContain("min-width: 44px")
    expect(css).toContain("min-height: 44px")
    expect(css).toContain("min-width: 32px")
    expect(css).toContain("min-height: 32px")
  })
})
