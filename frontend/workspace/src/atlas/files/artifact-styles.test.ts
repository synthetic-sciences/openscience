import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const css = () => readFileSync(fileURLToPath(new URL("./FilesPane.css", import.meta.url)), "utf8")

// These three were all found by driving the real binary, and none of them could
// fail a component test: an undefined custom property, a losing specificity
// contest, and a missing gutter all render perfectly valid DOM.
describe("artifact grid styles", () => {
  test("uses only custom properties this app actually defines", () => {
    const used = [...css().matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!)
    const defined = new Set([
      // workspace/src/styles/atlas.css aliases
      "--color-bg",
      "--color-bg-subtle",
      "--color-surface",
      "--color-surface-solid",
      "--color-text",
      "--color-text-muted",
      "--color-text-faint",
      "--color-border",
      // @synsci/ui semantic tokens
      "--color-border-base",
      "--color-border-weak-base",
      "--color-text-weak",
      "--syntax-critical",
      "--font-code",
    ])
    const unknown = [...new Set(used)].filter((name) => !defined.has(name))

    // --color-bg-base was used here and does not exist: the menu's background
    // resolved to nothing and the card's text showed straight through it.
    expect(unknown).toEqual([])
  })

  test("keeps a floating menu opaque in both themes", () => {
    // --color-surface-solid is the alias for the explicitly non-alpha surface.
    // Dark's ordinary --surface-* tokens are alpha overlays.
    expect(css()).toMatch(/\.artifact-menu\s*\{[^}]*background: var\(--color-surface-solid\)/s)
    expect(css()).toMatch(/\.artifact-menu\s*\{[^}]*position: fixed/s)
  })

  test("wins the specificity contest for the destructive item", () => {
    // `.artifact-menu button` is compound and outranks a lone class, so the
    // danger rule has to be compound too or it never paints.
    expect(css()).toContain(".artifact-menu button.artifact-menu__danger")
  })

  test("gives the grid the same gutter as the rest of the pane", () => {
    const gutter = /\.files-search-row\s*\{[^}]*padding: 0 12px/s.test(css())
    expect(gutter).toBe(true)
    expect(css()).toMatch(/\.artifact-surface\s*\{[^}]*padding: 0 12px/s)
  })

  test("reveals the card's actions on focus, not only on hover", () => {
    expect(css()).toContain(".artifact-card__actions:focus-visible")
  })
})
