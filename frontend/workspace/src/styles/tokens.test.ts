import { describe, expect, test } from "bun:test"
import { FONT_CODE, FONT_SANS, RADIUS, SURFACE_RADIUS } from "./tokens"

const SANS =
  '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

describe("workspace font tokens", () => {
  test("uses the exact canonical sans fallback in TypeScript", () => {
    expect(FONT_SANS).toBe(`var(--font-family-sans, ${SANS})`)
  })

  test("uses the exact canonical sans stack in shared CSS", async () => {
    const css = await Bun.file(new URL("../../../ui/src/styles/theme.css", import.meta.url)).text()
    const stack = css
      .match(/--font-family-sans:\s*([^;]+);/)?.[1]
      .replace(/\s+/g, " ")
      .trim()

    expect(stack).toBe(SANS)
  })

  test("bundles Inter Variable in the workspace entrypoint", async () => {
    const css = await Bun.file(new URL("../index.css", import.meta.url)).text()

    expect(css).toContain('@import "@fontsource-variable/inter/wght.css"')
  })

  test("resolves code through the shared mono stack with a genuine fallback", () => {
    expect(FONT_CODE).toStartWith('var(--font-family-mono, "Söhne Mono", "Sohne Mono"')
    expect(FONT_CODE).toEndWith("monospace)")
  })
})

describe("workbench visual scale", () => {
  test("uses readable shared type and a soft control radius", async () => {
    const css = await Bun.file(new URL("../../../ui/src/styles/theme.css", import.meta.url)).text()

    expect(css).toContain("--font-size-base: 14px")
    expect(css).toContain("--font-size-large: 16px")
    expect(css).toContain("--font-size-x-large: 20px")
    expect(css).toContain("--radius-md: 0.75rem")
    expect(css).toContain("--radius-xl: 1.25rem")
    expect(RADIUS).toBe(12)
    expect(SURFACE_RADIUS).toBe(20)
  })

  test("defines one floating composer geometry contract", async () => {
    const shell = await Bun.file(new URL("./atlas.css", import.meta.url)).text()
    const composer = await Bun.file(new URL("../components/prompt-input.css", import.meta.url)).text()
    const conversation = await Bun.file(new URL("../components/chat-surface.css", import.meta.url)).text()

    expect(shell).toContain("--workspace-composer-reserve: 116px")
    expect(shell).not.toContain("--workspace-composer-radius")
    expect(shell).not.toContain("\n.workspace-composer {")
    expect(conversation).toContain("width: min(100%, 740px)")
    expect(composer).toMatch(/form\.workspace-composer\s*\{[^}]*min-height: 88px/s)
    expect(composer).toContain("border-radius: var(--radius-lg)")
  })
})

describe("workspace motion contract", () => {
  test("uses shared timing tokens and explicit transition properties", async () => {
    const css = await Bun.file(new URL("./atlas.css", import.meta.url)).text()

    expect(css).not.toContain("transition: all")
    expect(css).toContain("background-color var(--duration-fast) var(--ease-standard)")
    expect(css).toContain("box-shadow var(--duration-slow) var(--ease-out-expo)")
    expect(css).toContain(".atlas-btn:active:not(:disabled)")
    expect(css).toContain("transform: scale(0.98)")
  })
})
