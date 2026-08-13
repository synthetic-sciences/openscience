import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")

const surface = (source: string, selector: string) => {
  const start = source.indexOf(selector)
  const end = source.indexOf("}", start)
  return source.slice(start, end)
}

describe("shared overlay boundary language", () => {
  test("gives popovers, menus, and selects one translucent edge and one elevation", () => {
    const overlays = [
      [read("./popover.css"), '[data-component="popover-content"]'],
      [read("./dropdown-menu.css"), '[data-component="dropdown-menu-content"]'],
      [read("./select.css"), '[data-component="select-content"]'],
    ] as const

    for (const [source, selector] of overlays) {
      const rules = surface(source, selector)
      expect(rules).toContain("border: 1px solid var(--border-weak-base)")
      expect(rules).toContain("background-clip: padding-box")
      expect(rules).toContain("box-shadow: var(--shadow-md)")
    }
  })

  test("keeps settings selects tonal instead of drawing a hover border with shadow", () => {
    const source = read("./select.css")

    expect(source).not.toContain("box-shadow: var(--shadow-xs-border-base)")
    expect(source).not.toContain("box-shadow: var(--shadow-xs-border);")
  })
})
