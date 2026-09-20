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

// Stand-ins for the theme layer both surfaces inherit from, so a computed value
// names the declaration that won instead of a token happy-dom cannot resolve.
const TOKENS = `
.settings-dialog, .session-sidebar {
  --font-mono: ProbeMono;
  --font-family-sans: ProbeSans;
  --font-family-mono: ProbeMono;
  --font-size-x-small: 11px;
  --font-weight-medium: 500;
  --sidebar-space-2: 8px;
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
    const host = styled([dialog.SETTINGS_STYLES, TOKENS])
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
      [dialog.SETTINGS_STYLES, sidebar, TOKENS],
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
