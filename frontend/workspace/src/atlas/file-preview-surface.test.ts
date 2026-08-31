import { describe, expect, test } from "bun:test"

const css = await Bun.file(new URL("./FilePreview.css", import.meta.url)).text()
const textView = await Bun.file(new URL("./files/TextContentView.tsx", import.meta.url)).text()

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
    expect(css).toContain("width: min(100%, calc(76ch + 48px))")
    expect(css).toContain("font-family: var(--font-family-sans)")
    expect(css).toContain("font-size: 13px")
    expect(css).toContain("padding: 24px 24px 48px")
    expect(css).toContain("padding-inline: 16px")
  })

  test("keeps compact proportional typography inside file previews only", () => {
    expect(css).toMatch(/\.atlas-file-document\s*\{[^}]*font-size: var\(--document-font-size, 13px\)/s)
    expect(css).toMatch(/\.atlas-file-document \.atlas-md\s*\{[^}]*font-size: inherit;[^}]*line-height: 1\.65/s)
    expect(css).toMatch(/\.atlas-file-document \.atlas-md h1\s*\{[^}]*font-size: 1\.5em/s)
    expect(css).toMatch(/\.atlas-file-document \.atlas-md h2\s*\{[^}]*font-size: 1\.25em/s)
    expect(css).toMatch(/\.atlas-file-document \.atlas-md h3\s*\{[^}]*font-size: 1\.1em/s)
    expect(css).toContain("font-size: max(12px, 0.87em)")
    expect(css).toContain("font-size: max(12px, 0.9em)")
  })

  test("shares document typography with stored artifacts and notebook Markdown", () => {
    expect(textView).toContain('import "../FilePreview.css"')
    expect(textView).toContain('import { MarkdownDocument } from "../MarkdownDocument"')
    expect(textView).toContain('class="atlas-file-document atlas-file-notebook"')
    expect(textView).toContain("<MarkdownDocument name={props.name} text={props.text}")
    expect(textView).toContain('<Markdown class="atlas-md" text={cell.source}')
    expect(textView).not.toContain('class="markdown-body"')
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
    expect(css).toContain('grid-template-areas: "identity close" "controls controls"')
    expect(css).toMatch(/\.atlas-file-controls\s*\{[^}]*flex-wrap: wrap/s)
    expect(css).toMatch(/\.atlas-file-scroll\.is-managed-scroll,[\s\S]*overflow: hidden/s)
    expect(css).toMatch(/\.atlas-file-pdf\s*\{[^}]*flex: 1/s)
    expect(css).toMatch(/\.atlas-file-pdf \.pdf-viewer\s*\{[^}]*height: 100%/s)
  })
})
