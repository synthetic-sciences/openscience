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
    expect(session).toContain('class="workspace-header__project"')
    expect(session).toContain('class="session-sidebar__new"')
    expect(session).toContain('aria-label="Research sessions"')
    expect(session).toContain('data-component="conversation-center"')
    expect(session).toContain('aria-label="Conversation"')
    expect(session).toContain('class="workspace-tabs"')
    expect(session).toContain('aria-label="Open session tabs"')
    expect(session).not.toContain('role="tabpanel"')
    expect(session).not.toContain("centerPanelId")
    expect(session).not.toContain("centerTabId")
    expect(session).not.toContain('class="workspace-header__menu"')
    expect(session).not.toContain('class="workspace-header__search"')
    expect(session).not.toContain("<HeaderDivider")
    expect(session).not.toContain('<Wordmark size="sm"')
    expect(session).not.toContain('placeholder="Search sessions"')
    expect(session).not.toContain(">New session</span> above.")
    expect(session).toContain('class="session-sidebar__project"')
    expect(session).toContain("No sessions yet.")
    expect(session).toContain("data-context-open={uiStore.rightPaneOpen()")
    expect(session).toContain('return s?.title || "New session"')
  })

  test("keeps the conversation as the sole center surface", () => {
    const session = read("./session.tsx")

    expect(session).toContain('class="session-main"')
    expect(session).toContain('aria-label="Conversation"')
    expect(session).toContain('data-component="conversation-center"')
    expect(session).not.toContain("visitedFiles")
    expect(session).not.toContain("centerTabs")
    expect(session).not.toContain("<CenterTabStrip")
    expect(session).not.toContain('import { FileView } from "@/atlas/FilePreview"')
  })

  test("keeps Skills in Customize instead of the primary work tabs", () => {
    const session = read("./session.tsx")

    expect(session).toContain('ariaLabel="Customize OpenScience"')
    expect(session).toContain("dialog.show(() => <DialogSettings />)")
    expect(session).not.toContain('import SkillsPage from "@/atlas/SkillsPage"')
    expect(session).not.toContain('centerTabs.active() === "skills"')
    expect(session).not.toContain('label="Skills"')
  })

  test("keeps contextual navigation in the compact left rail", () => {
    const session = read("./session.tsx")
    const action = read("./session-sidebar-action.tsx")

    expect(session).toContain('aria-label="Research navigation"')
    expect(session).toContain('ariaLabel="New research"')
    expect(session).toContain('ariaLabel="Search project"')
    expect(session).toContain('ariaLabel="Customize OpenScience"')
    expect(action).toContain('ariaLabel="Open project files"')
    expect(action).toContain('ariaLabel="Open project terminal"')
    expect(action).toContain('ariaLabel="Open Atlas"')
    expect(action).not.toContain('ariaLabel="Open Evidence"')
    expect(action).toContain('ariaLabel="Open session compute"')
    expect(action).toContain('ariaLabel="Open file details"')
    expect(session).toContain("context={uiStore.context()}")
    expect(session).toContain("contextOpen={uiStore.open()}")
    expect(session).toContain("artifact={Boolean(artifactContext.active())}")
    expect(session).toContain("uiStore.openContext(context)")
    expect(session).toContain("uiStore.setPaletteOpen(true)")
    expect(session).toContain("dialog.show(() => <DialogSettings />)")
    expect(action).toContain('onClick={(_event?: Event) => props.onContext("files")}')
    expect(action).toContain('onClick={(_event?: Event) => props.onContext("terminal")}')
    expect(session).not.toContain("<CompactContextActions")
    expect(action).toContain('props.onContext("files")')
    expect(action).toContain('props.onContext("terminal")')
    expect(action).toContain('props.onContext("kernels")')
    expect(action).toContain("<Show when={props.atlas}>")
    expect(session).not.toContain("centerTabs.showFiles()")
    expect(session).not.toContain("uiStore.setRightPaneOpen(true)")
    expect(session).not.toContain("onOpenTools")
    expect(session).not.toContain(">Inspector</span>")
  })

  test("derives Files and contextual selection from the surfaces they open", () => {
    const session = read("./session.tsx")
    const action = read("./session-sidebar-action.tsx")
    const styles = read("../styles/atlas.css")

    expect(action).toContain('active={props.context === "files" && props.contextOpen}')
    expect(action).toContain('active={props.context === "terminal" && props.contextOpen}')
    expect(action).toContain('active={props.context === "canvas" && props.contextOpen}')
    expect(action).not.toContain('active={props.context === "evidence" && props.contextOpen}')
    expect(action).toContain('active={props.context === "kernels" && props.contextOpen}')
    expect(action).toContain('active={props.context === "artifact" && props.contextOpen}')
    expect(action).toContain("aria-pressed={props.active === undefined ? undefined : props.active}")
    expect(action).toContain('data-selected={props.active ? "true" : undefined}')
    expect(styles).toContain('.session-sidebar__action[data-selected="true"]')
  })

  test("keeps rail actions above recents and closes the mobile drawer after navigation", () => {
    const session = read("./session.tsx")
    const navigation = session.indexOf('aria-label="Research navigation"')
    const recents = session.indexOf("Recent sessions")

    expect(navigation).toBeGreaterThan(-1)
    expect(recents).toBeGreaterThan(navigation)
    expect(session).toContain('class="session-sidebar__actions"')
    expect(session).toContain("onSearch={() => {")
    expect(session).toContain("onCustomize={() => {")
    expect(session).toContain("onContext={(context) => {")
    expect(session).toContain("setMobileSessionsOpen(false)")
    expect(session).toContain("navigate(`/${params.dir}/session/new`)")
    expect(session).toContain("prompt.reset()")
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
    expect(session).toContain('class="session-transcript')
    expect(session).not.toContain('class="h-[2px] bg-border-weak-base rounded-full"')
    expect(styles).toContain('.session-scroller [data-slot="session-turn-sticky"]')
    expect(styles).toContain('.session-scroller [data-slot="session-turn-message-content"]')
    expect(styles).toContain("width: min(100%, 740px)")
    expect(styles).toContain("height: 18px")
  })

  test("keeps the desktop research rail narrow and session rows single-line", () => {
    const session = read("./session.tsx")
    const styles = read("../styles/atlas.css")

    expect(session).toContain('class="session-sidebar__session"')
    expect(session).toContain('class="session-sidebar__session-title"')
    expect(session).not.toContain("DateTime.fromMillis")
    expect(styles).toContain("width: 196px")
    expect(styles).toContain("min-height: 31px")
    expect(styles).toContain("font-size: 12px")
  })

  test("persists sidebar collapse and session pin actions", () => {
    const session = read("session.tsx")
    const styles = read("../styles/atlas.css")

    expect(session).toContain("openscience-session-sidebar-v1")
    expect(session).toContain("sync.session.pin(sessionID, pinned)")
    expect(session).toContain('aria-label={props.session.title || "session"}')
    expect(session).toContain('data-pinned={props.session.time?.pinned ? "true" : undefined}')
    expect(session).toContain('title: "Delete this session?"')
    expect(session).toContain("uiStore.activateScope(sdk.scope, id)")
    expect(styles).toContain('.session-sidebar[data-collapsed="true"]')
  })

  test("keeps research tools in a route-owned contextual surface", () => {
    const pane = read("../atlas/RightPane.tsx")

    expect(pane).toContain("paneWidthKey(project(), session())")
    expect(pane).toContain("DEFAULT_PANE_WIDTH")
    expect(pane).toContain('"min(520px, calc(100vw - 48px))"')
    expect(pane).toContain('aria-label="Research inspector"')
    expect(pane).toContain('class="research-inspector__header"')
    expect(pane).toContain('class="research-inspector__context"')
    expect(pane).toContain("<TerminalSurface />")
    expect(pane).toContain("narrow() ? uiStore.closeContext() : uiStore.closeWorkTab()")
    expect(pane).toContain("<WorkTabStrip")
    expect(pane).not.toContain('class="research-inspector__tabs"')
    expect(pane).not.toContain('class="research-tool-rail"')
    expect(pane).toContain("modal={narrow() || expanded()}")
    expect(pane).toContain("mobile={narrow()}")
    expect(pane).toContain("stacked={false}")
    expect(pane).toContain('aria-label={expanded() ? "Restore inspector" : "Open inspector full screen"}')
    expect(pane).toContain("window.innerWidth < INLINE_PANE_BREAKPOINT")
    expect(pane).toContain("paneWidthForViewport(width(), viewport())")
  })

  test("contains inspector startup suspension inside the pane", () => {
    const pane = read("../atlas/RightPane.tsx")

    expect(pane).toContain("<Suspense fallback={<InspectorLoading")
    expect(pane).toContain('data-component="inspector-loading"')
  })
})
