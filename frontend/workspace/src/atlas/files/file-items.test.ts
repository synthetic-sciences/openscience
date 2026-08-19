import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const css = () => readFileSync(fileURLToPath(new URL("./file-items.css", import.meta.url)), "utf8")

describe("file catalog styles", () => {
  test("keeps the selected grid visibly a grid at narrow pane widths", () => {
    const styles = css()

    expect(styles).toMatch(
      /@container files-pane \(max-width: 400px\)[\s\S]*\.artifact-grid\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
    )
    expect(styles).not.toMatch(/\.artifact-grid\s*\{[^}]*display: flex;[^}]*flex-direction: column/s)
  })

  test("uses the shared spacing and surface tokens without decorative borders", () => {
    const styles = css()

    expect(styles).not.toContain("linear-gradient")
    expect(styles).not.toContain("border: 1px")
    expect(styles).toContain("var(--color-border-weak-base)")
    expect(styles).toContain("var(--color-text-muted)")
  })

  test("keeps narrow artifact cards compact without permanently showing every action", () => {
    const styles = css()

    expect(styles).toMatch(/\.artifact-toolbar__primary\s*\{[^}]*flex-direction: row/s)
    expect(styles).toMatch(/\.artifact-menu__section\s*\{[^}]*padding: 5px 7px 2px/s)
    expect(styles).toMatch(/@container files-pane \(max-width: 400px\)[\s\S]*\.artifact-thumb\s*\{[^}]*height: 52px/s)
    expect(styles).not.toMatch(
      /@container files-pane \(max-width: 400px\)[\s\S]*\.artifact-card__actions\s*\{[^}]*opacity: 1/s,
    )
  })
})
