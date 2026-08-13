import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")

const variant = (source: string, name: string) => {
  const start = source.indexOf(`&[data-variant="${name}"]`)
  const next = source.indexOf("&[data-variant=", start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

describe("shared surface boundary language", () => {
  test("keeps standalone actions borderless at rest and bounded only for keyboard focus", () => {
    for (const file of ["./button.css", "./icon-button.css"]) {
      const source = read(file)

      expect(variant(source, "primary")).toContain("box-shadow: var(--shadow-xs-border-focus)")
      expect(variant(source, "ghost")).toContain("box-shadow: var(--shadow-xs-border-focus)")

      const secondary = variant(source, "secondary")
      expect(secondary).toContain("box-shadow: none")
      expect(secondary).not.toContain("box-shadow: var(--shadow-xs-border);")
      expect(secondary).toContain("box-shadow: var(--shadow-xs-border-focus)")
    }
  })

  test("reserves persistent boundaries for containment and input affordance", () => {
    expect(read("./card.css")).toContain("border: 1px solid var(--border-weaker-base)")
    expect(read("./text-field.css")).toContain("border: 1px solid var(--border-weak-base)")
    expect(read("./popover.css")).toContain("border: 1px solid")
  })
})
