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
      "--font-family-sans",
      "--font-weight-emphasis",
      "--font-weight-medium",
      "--letter-spacing-normal",
      "--atlas-radius-xs",
      "--atlas-radius-sm",
      "--atlas-radius-md",
      "--atlas-shadow-xs",
      "--atlas-shadow-md",
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

  test("keeps the browser continuous while sharing the content gutter", () => {
    const styles = css()

    expect(styles).toMatch(/\.files-browser\s*\{[^}]*margin: 0;[^}]*border: 0;[^}]*border-radius: 0/s)
    expect(styles).toMatch(/\.files-browser__header\s*\{[^}]*padding: 6px 10px 4px;[^}]*border: 0/s)
    expect(styles).toMatch(/\.artifact-surface\s*\{[^}]*padding: 2px 10px 10px/s)
    expect(styles).toMatch(/\.remote-view\s*\{[^}]*margin: 0;[^}]*border: 0;[^}]*border-radius: 0/s)
  })

  test("keeps source and search in one compact resize-safe toolbar", () => {
    const styles = css()

    expect(styles).toMatch(/\.files-browser__toolbar\s*\{[^}]*display: flex;[^}]*min-width: 0/s)
    expect(styles).toMatch(/\.files-browser__toolbar \.files-source\s*\{[^}]*max-width: min\(34cqi, 160px\)/s)
    expect(styles).toMatch(/\.files-search\s*\{[^}]*flex: 1 1 160px;[^}]*min-height: 30px/s)
    expect(styles).toMatch(
      /\.artifact-grid\s*\{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(164px, 100%\), 1fr\)\)/s,
    )
    expect(styles).toMatch(
      /\.artifact-card\[data-layout="grid"\] \.artifact-card__name\s*\{[^}]*overflow-wrap: anywhere;[^}]*-webkit-line-clamp: 3/s,
    )
  })

  test("lets sparse Result grids use the pane and keeps code thumbnails legible", () => {
    const styles = css()
    const responsive = readFileSync(fileURLToPath(new URL("./file-items.css", import.meta.url)), "utf8")

    expect(styles).toMatch(/\.artifact-thumb--text\s*\{[^}]*font-size: 8px;[^}]*line-height: 1\.5;/s)
    expect(responsive).toMatch(
      /@container files-pane \(max-width: 400px\)[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(min\(152px, 100%\), 1fr\)\)/,
    )
    expect(responsive).toMatch(/\.artifact-thumb\s*\{[^}]*height: 82px;/s)
  })

  test("uses spacing and hover states instead of nested file borders", () => {
    const styles = css()

    expect(styles).toMatch(/\.files-source__button\s*\{[^}]*border: 0;/s)
    expect(styles).toMatch(/\.files-search\s*\{[^}]*border: 0;/s)
    expect(styles).toMatch(/\.files-row\s*\{[^}]*border: 0;/s)
    expect(styles).toMatch(/\.artifact-card\[data-layout="grid"\]\s*\{[^}]*border: 0;/s)
    expect(styles).toMatch(/\.artifact-card\[data-layout="grid"\] \.artifact-thumb\s*\{[^}]*border: 0;/s)
  })

  test("uses the shared radius ladder and no clipped decorative gradients", () => {
    const styles = css()
    const rawPixelRadii = [...styles.matchAll(/border-radius:\s*(\d+(?:\.\d+)?)px/g)].map((match) => match[1]!)

    expect(styles).toContain("border-radius: var(--atlas-radius-md)")
    expect(styles).toContain("border-radius: var(--atlas-radius-sm)")
    expect(styles).toContain("border-radius: var(--atlas-radius-xs)")
    expect(styles).toMatch(/\.files-menu__badge\s*\{[^}]*border-radius: 999px/s)
    expect(styles).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*border-radius: 999px/s)
    expect(rawPixelRadii).toEqual(["999", "999"])
    expect(styles).not.toContain("linear-gradient")
    expect(styles).not.toContain("mask-image")
  })

  test("reveals the card's actions on focus, not only on hover", () => {
    expect(css()).toContain(".artifact-card__actions:focus-visible")
  })

  test("uses calm desktop motion and full coarse-pointer targets", () => {
    const styles = css()

    expect(styles).toContain("background-color 140ms ease")
    expect(styles.match(/@media \(pointer: coarse\)/g)).toHaveLength(1)
    expect(styles).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/)
  })
})
