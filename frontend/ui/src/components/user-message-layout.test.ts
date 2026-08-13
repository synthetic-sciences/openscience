import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()
const css = await Bun.file(new URL("./message-part.css", import.meta.url)).text()
const turnCss = await Bun.file(new URL("./session-turn.css", import.meta.url)).text()
const turnSource = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

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

  test("uses the same borderless copy control as assistant responses", () => {
    const userCopy = source.indexOf('data-slot="user-message-copy-wrapper"')
    const userText = source.indexOf('data-slot="user-message-text"', userCopy)
    const response = turnSource.indexOf('data-slot="session-turn-response-copy-wrapper"')
    expect(userCopy).toBeGreaterThan(-1)
    expect(userText).toBeGreaterThan(userCopy)
    expect(response).toBeGreaterThan(-1)
    expect(source.slice(userCopy, userText)).toContain('variant="ghost"')
    expect(source.slice(userCopy, userText)).not.toContain('variant="secondary"')
    expect(turnSource.slice(response, response + 900)).toContain('variant="ghost"')
  })

  test("uses tonal containment instead of outlining the sent-message bubble", () => {
    const message = css.match(/\[data-slot="user-message-text"\]\s*\{([^}]*)\}/s)?.[1] ?? ""

    expect(message).toContain("background: var(--surface-weak)")
    expect(message).toContain("border: 0")
  })

  test("keeps assistant copy reachable by focus, copied feedback, and touch", () => {
    expect(turnSource).toContain('data-copied={copied() ? "true" : undefined}')
    expect(turnCss).toContain('[data-slot="session-turn-response"]:focus-within')
    expect(turnCss).toContain('[data-slot="session-turn-response-copy-wrapper"][data-copied="true"]')
    expect(turnCss).toContain("@media (pointer: coarse)")
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

  test("keeps the long-message action compact, discoverable, and outside the reading surface", () => {
    const content = source.indexOf('data-slot="user-message-content"')
    const text = source.indexOf('data-slot="user-message-text"', content)
    const expand = source.indexOf('data-slot="user-message-expand"', text)

    expect(content).toBeGreaterThan(-1)
    expect(text).toBeGreaterThan(content)
    expect(expand).toBeGreaterThan(text)
    expect(source.slice(text, expand)).toContain("<Tooltip")
    expect(source).not.toContain('data-slot="user-message-expand-label"')
    expect(turnCss).toContain("width: 32px")
    expect(turnCss).toContain("min-height: 32px")
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
