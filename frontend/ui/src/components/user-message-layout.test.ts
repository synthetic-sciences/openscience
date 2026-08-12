import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()
const css = await Bun.file(new URL("./message-part.css", import.meta.url)).text()
const turnCss = await Bun.file(new URL("./session-turn.css", import.meta.url)).text()

describe("user message layout", () => {
  test("places the copy action before and outside the message bubble", () => {
    const row = source.indexOf('data-slot="user-message-row"')
    const copy = source.indexOf('data-slot="user-message-copy-wrapper"', row)
    const text = source.indexOf('data-slot="user-message-text"', row)

    expect(row).toBeGreaterThan(-1)
    expect(copy).toBeGreaterThan(row)
    expect(text).toBeGreaterThan(copy)
    expect(source.slice(copy, text)).toContain('variant="ghost"')
    expect(source.slice(copy, text)).toContain('type="button"')
  })

  test("keeps copy discoverable by hover, keyboard focus, and touch", () => {
    expect(css).toContain('[data-slot="user-message-row"]:hover [data-slot="user-message-copy-wrapper"]')
    expect(css).toContain('[data-slot="user-message-row"]:focus-within [data-slot="user-message-copy-wrapper"]')
    expect(css).toContain("@media (pointer: coarse)")

    const copyRule = css.match(/\[data-slot="user-message-copy-wrapper"\]\s*\{([^}]*)\}/s)?.[1] ?? ""
    expect(copyRule).toContain("opacity: 0")
    expect(copyRule).not.toContain("position: absolute")
  })

  test("uses the same surface token for the collapsed-message fade", () => {
    expect(turnCss).toContain("var(--user-message-surface, var(--surface-weak))")
    expect(turnCss).toContain("transition: transform var(--duration-fast) var(--ease-standard)")
  })

  test("keeps sent attachment filenames, formats, and open affordances visible", () => {
    expect(source).toContain('data-slot="user-message-attachment-copy"')
    expect(source).toContain("attachmentFormat(file)")
    expect(source).toContain('target="_blank"')
    expect(source).toContain('<Icon name="file" />')
    expect(css).toContain("grid-template-columns: 40px minmax(0, 1fr)")
    expect(css).toContain("font-weight: var(--font-weight-regular)")
    expect(css).toContain("font-weight: var(--font-weight-medium)")
  })
})
