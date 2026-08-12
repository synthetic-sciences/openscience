import { describe, expect, test } from "bun:test"

const theme = await Bun.file(new URL("./theme.css", import.meta.url)).text()
const base = await Bun.file(new URL("./base.css", import.meta.url)).text()
const tailwind = await Bun.file(new URL("./tailwind/index.css", import.meta.url)).text()
const components = await Array.fromAsync(
  new Bun.Glob("*.css").scan({
    cwd: new URL("../components/", import.meta.url).pathname,
    absolute: true,
  }),
)

describe("shared typography contract", () => {
  test("uses one quiet semantic weight scale throughout the app shell", () => {
    expect(theme).toContain("--font-weight-regular: 380")
    expect(theme).toContain("--font-weight-medium: 480")
    expect(theme).toContain("--font-weight-emphasis: 500")
    expect(base).toMatch(/html,\s*:host\s*\{[^}]*font-weight: var\(--font-weight-regular\)/s)
    expect(tailwind).toContain("--font-weight-normal: var(--font-weight-regular)")
    expect(tailwind).toContain("--font-weight-medium: var(--font-weight-medium)")
    expect(tailwind).toContain("--font-weight-semibold: var(--font-weight-emphasis)")
  })

  test("keeps shared component hierarchy semantic instead of hard-coded or all caps", async () => {
    for (const path of components) {
      const css = await Bun.file(path).text()
      expect(css.match(/(?<!-)font-weight:\s*(?:[1-9]\d{2}|bold|normal)\b/g), path).toBeNull()
      expect(css.match(/text-transform:\s*(?:uppercase|lowercase|capitalize)\b/g), path).toBeNull()
    }
  })

  test("preserves explicit strong and code semantics in the base reset", () => {
    expect(base).toMatch(/b,\s*strong\s*\{\s*font-weight: bolder;/s)
    expect(base).toMatch(/code,\s*kbd,\s*samp,\s*pre\s*\{[^}]*font-family: var\(--font-family-mono\)/s)
  })
})
