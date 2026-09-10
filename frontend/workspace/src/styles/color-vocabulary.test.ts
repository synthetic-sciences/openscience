import { describe, expect, test } from "bun:test"

const root = new URL("../", import.meta.url).pathname
const files = await Array.fromAsync(new Bun.Glob("**/*.{css,ts,tsx}").scan({ cwd: root }))

/**
 * The workspace speaks one colour vocabulary, --color-*, defined once in
 * styles/atlas.css as aliases over the @synsci/ui semantic tokens. Reaching
 * for a raw token elsewhere is how two panels end up with two greys.
 */
describe("workspace colour vocabulary", () => {
  test("stylesheets and components use --color-* aliases, never raw semantic tokens", async () => {
    for (const path of files) {
      if (path.includes(".test.") || path === "styles/atlas.css") continue
      const text = await Bun.file(new URL(path, new URL("../", import.meta.url))).text()
      const raw = text.match(/var\(--(?:text|surface|border|background|icon|input|focus)-[a-z0-9-]+/g)
      expect(raw, `${path} uses ${[...new Set(raw ?? [])].join(", ")}`).toBeNull()
    }
  })

  test("every alias the workspace uses is defined", async () => {
    const atlas = await Bun.file(new URL("atlas.css", import.meta.url)).text()
    const defined = new Set([...atlas.matchAll(/^\s*(--color-[a-z0-9-]+):/gm)].map((match) => match[1]))
    for (const path of files) {
      if (path.includes(".test.") || path === "styles/atlas.css") continue
      const text = await Bun.file(new URL(path, new URL("../", import.meta.url))).text()
      for (const match of text.matchAll(/var\((--color-[a-z0-9-]+)/g)) {
        expect(defined.has(match[1]!), `${path} uses undefined ${match[1]}`).toBe(true)
      }
    }
  })
})
