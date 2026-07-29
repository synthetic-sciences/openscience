import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("session render boundary", () => {
  test("keeps session-only render dependencies behind the lazy route", () => {
    const app = read("../app.tsx")

    expect(app).toContain('const Session = lazy(() => import("@/pages/session-shell"))')
    expect(app).not.toContain("@synsci/ui/context/marked")
    expect(app).not.toContain("@synsci/ui/context/diff")
    expect(app).not.toContain("@synsci/ui/context/code")
    expect(app).not.toContain("@synsci/ui/diff")
    expect(app).not.toContain("@synsci/ui/code")
    expect(app).not.toContain("@/science/tool-renderer")
  })

  test("preserves registration and provider order inside the session shell", () => {
    const shell = read("./session-shell.tsx")
    const registration = shell.indexOf('import "@/science/tool-renderer"')
    const sessionPage = shell.indexOf('import SessionPage from "./session"')
    const marked = shell.indexOf("<MarkedProvider")
    const diff = shell.indexOf("<DiffComponentProvider")
    const code = shell.indexOf("<CodeComponentProvider")
    const children = shell.indexOf("{props.children}")

    expect(registration).toBeGreaterThan(-1)
    expect(sessionPage).toBeGreaterThan(registration)
    expect(marked).toBeGreaterThan(-1)
    expect(diff).toBeGreaterThan(marked)
    expect(code).toBeGreaterThan(diff)
    expect(children).toBeGreaterThan(code)
  })
})

describe("focused workspace shell", () => {
  test("keeps navigation quiet and gives each shell region a semantic contract", () => {
    const session = read("./session.tsx")

    expect(session).toContain('class="workspace-header"')
    expect(session).toContain('class="session-sidebar__new"')
    expect(session).toContain('class="workspace-tabs')
    expect(session).toContain('class="workspace-header__menu"')
    expect(session).not.toContain("<HeaderDivider")
    expect(session).not.toContain('<Wordmark size="sm"')
    expect(session).not.toContain('placeholder="Search sessions"')
    expect(session).not.toContain(">New session</span> above.")
    expect(session).toContain(">New research</span> above.")
  })

  test("keeps the composer calm and gives narrow screens non-overlapping controls", () => {
    const session = read("./session.tsx")
    const prompt = read("../components/prompt-input.tsx")

    expect(session).toContain('class="session-prompt-dock"')
    expect(session).toContain('class="session-prompt-dock__inner"')
    expect(session).not.toContain("bg-gradient-to-t")
    expect(prompt).toContain('"workspace-composer": true')
    expect(prompt).toContain('class="workspace-composer__footer"')
    expect(prompt).toContain('class="workspace-composer__controls')
    expect(prompt).toContain('class="workspace-composer__actions')
  })

  test("lets research turns flow without sticky cards or heavy dividers", () => {
    const session = read("./session.tsx")
    const styles = read("../styles/atlas.css")

    expect(session).toContain('class="session-turn-divider"')
    expect(session).not.toContain('class="h-[2px] bg-border-weak-base rounded-full"')
    expect(styles).toContain('.session-scroller [data-slot="session-turn-sticky"]')
    expect(styles).toContain('.session-scroller [data-slot="session-turn-message-content"]')
  })

  test("keeps research tools in a compact contextual inspector", () => {
    const pane = read("../atlas/RightPane.tsx")

    expect(pane).toContain('const RIGHT_PANE_WIDTH_KEY = "openscience-research-inspector-width-v2"')
    expect(pane).toContain("return 360")
    expect(pane).toContain('class="research-inspector__tabs"')
    expect(pane).toContain('class="research-inspector__tab"')
    expect(pane).toContain('class="research-tool-rail"')
  })
})
