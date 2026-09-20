import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const server = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [fixture, dialog, web] = await Promise.all([
  server.ssrLoadModule("/src/components/settings/settings-labels.fixture.tsx") as Promise<
    typeof import("./settings-labels.fixture")
  >,
  server.ssrLoadModule("/src/components/dialog-settings.tsx") as Promise<typeof import("../dialog-settings")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const sidebar = await Bun.file(new URL("../../pages/session-sidebar.css", import.meta.url)).text()
// The real tokens both rules read (font size, weight, family). Loading the
// theme layer itself, rather than standing in for it, is what makes the
// cross-surface comparisons below hold by construction: they fail if the two
// rules ever resolve differently, not only if someone edits this file.
// happy-dom's CSS parser drops a plain rule's declarations that precede a
// nested at-rule (verified: `:root { --a: 1; @media (...) { } }` parses to
// `:root { }`, losing --a), and theme.css nests `@media
// (prefers-color-scheme: dark)` as :root's last rule — loading the file
// verbatim would silently empty out every token below. Load only the
// light-mode :root block that precedes it, still the file's own text.
const themeSource = await Bun.file(new URL("../../../../ui/src/styles/theme.css", import.meta.url)).text()
const themeCut = themeSource.indexOf("@media (prefers-color-scheme: dark)")
if (themeCut < 0) throw new Error("theme.css no longer nests a prefers-color-scheme block inside :root")
const theme = `${themeSource.slice(0, themeCut)}}`

// `--font-mono` stays a stand-in: it is a Tailwind `@theme` utility token that
// only exists after the Tailwind build runs, which this harness does not do.
// The mono test below checks which declaration's cascade wins, not the
// font's real value, so a distinguishable placeholder is enough.
const MONO_TOKEN = `
.settings-dialog {
  --font-mono: ProbeMono;
}
`

const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.head.replaceChildren()
  document.body.replaceChildren()
})

function styled(css: string[], markup?: string) {
  for (const text of css) {
    const style = document.createElement("style")
    style.textContent = text
    document.head.append(style)
  }
  const host = document.createElement("div")
  if (markup) host.innerHTML = markup
  document.body.append(host)
  return host
}

/** The tracking a selector declares. `em` resolves against the ancestor font
 * size in this harness, so the two rails' computed pixels are not comparable —
 * their declarations are. */
function tracking(selector: string) {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const style = (rule as CSSStyleRule).style
      const selectors = (rule as CSSStyleRule).selectorText?.split(",").map((one) => one.trim())
      if (selectors?.includes(selector) && style?.letterSpacing) return style.letterSpacing
    }
  }
}

describe("Customize dialog labels and fields", () => {
  test("a field that asks for monospace keeps it inside the dialog", () => {
    const host = styled([dialog.SETTINGS_STYLES, MONO_TOKEN])
    host.className = "settings-dialog"
    cleanups.push(web.render(fixture.ConnectorFields, host))

    const inputs = host.querySelectorAll("input")
    expect(inputs).toHaveLength(2)
    // The dialog resets every control to `font-family: inherit`; without the
    // .settings-dialog .font-mono rule that reset swallows the utility too,
    // because Tailwind utilities sit in a lower cascade layer.
    expect(getComputedStyle(inputs[0]!).fontFamily).toBe("ProbeMono")
    expect(getComputedStyle(inputs[1]!).fontFamily).not.toBe("ProbeMono")
  })

  test("the rail names its groups in the project sidebar's own label metrics", () => {
    const host = styled(
      [dialog.SETTINGS_STYLES, sidebar, theme],
      `<div class="settings-dialog"><div class="settings-nav__label">Account</div></div>
       <div class="session-sidebar"><div class="session-sidebar__group-label">Workspace</div></div>`,
    )

    const rail = getComputedStyle(host.querySelector<HTMLElement>(".settings-nav__label")!)
    const project = getComputedStyle(host.querySelector<HTMLElement>(".session-sidebar__group-label")!)

    expect(rail.fontSize).toBe(project.fontSize)
    expect(rail.fontWeight).toBe(project.fontWeight)
    expect(rail.lineHeight).toBe(project.lineHeight)
    expect(rail.paddingTop).toBe(project.paddingTop)
    expect(rail.paddingBottom).toBe(project.paddingBottom)
    expect(rail.paddingLeft).toBe(project.paddingLeft)
    expect(rail.paddingRight).toBe(project.paddingRight)
    expect(rail.textTransform).toBe(project.textTransform)
    expect(tracking(".settings-nav__label")).toBe(tracking(".session-sidebar__group-label")!)
  })
})
