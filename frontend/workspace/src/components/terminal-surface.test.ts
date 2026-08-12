import { describe, expect, test } from "bun:test"
import { terminalEndpointAvailable } from "@/atlas/terminal-endpoint"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("contextual project terminal", () => {
  test("permits local PTY endpoints without exposing terminals on remote servers", () => {
    expect(terminalEndpointAvailable("http://localhost:4444")).toBe(true)
    expect(terminalEndpointAvailable("https://127.0.0.1:4096")).toBe(true)
    expect(terminalEndpointAvailable("http://[::1]:3000")).toBe(true)
    expect(terminalEndpointAvailable("", "http://localhost:4444")).toBe(true)
    expect(terminalEndpointAvailable("/api", "https://science.example.com")).toBe(false)
    expect(terminalEndpointAvailable("https://science.example.com")).toBe(false)
    expect(terminalEndpointAvailable("not a URL")).toBe(false)
  })

  test("mounts the terminal only as a selected right-pane context", async () => {
    const [pane, surface, action] = await Promise.all([
      read("../atlas/RightPane.tsx"),
      read("../atlas/TerminalSurface.tsx"),
      read("../pages/session-sidebar-action.tsx"),
    ])

    expect(pane).toContain('terminal: "Terminal"')
    expect(pane).toContain('context() === "terminal"')
    expect(pane).toContain("<TerminalSurface />")
    expect(action).toContain('ariaLabel="Open project terminal"')
    expect(action).toContain('props.onContext("terminal")')
    expect(action).toContain("onWarm={preloadTerminal}")
    expect(surface).toContain('aria-label="Session terminal"')
    expect(surface).toContain("useExecutionAuthority")
    expect(surface).toContain("!authority.allowed()")
    expect(surface).toContain('class="terminal-surface__tabs-row"')
    expect(surface).toContain('class="terminal-surface__new"')
    expect(surface).toContain('role="tablist"')
    expect(surface).toContain('role="tabpanel"')
    expect(surface).toContain("active={active()?.id === pty.id}")
    expect(surface).toContain("terminal.close(pty.id)")
    expect(surface).toContain(".clone(id)")
    expect(surface).toContain('class="terminal-surface__error"')
    expect(surface).toContain("Try again")
    expect(surface).toContain('import "@/atlas/TerminalSurface.css"')
    expect(surface).not.toContain('aria-label="Copy terminal selection"')
    expect(surface).not.toContain('aria-label="Copy all output"')
    expect(surface).not.toContain('aria-label="Find in terminal"')
    expect(surface).not.toContain('aria-label="Scroll to first output"')
    expect(surface).not.toContain('aria-label="Follow latest output"')
    expect(surface).not.toContain("terminal-surface__toolbar")
    expect(surface).not.toContain("terminal-surface__status-dot")
    expect(surface).not.toContain("terminal-surface__tab-dot")
  })

  test("offers keyboard and palette commands while keeping PTY requests project scoped", async () => {
    const [session, context, terminal] = await Promise.all([
      read("../pages/session.tsx"),
      read("../context/terminal.tsx"),
      read("./terminal.tsx"),
    ])

    expect(session).toContain('id: "terminal.toggle"')
    expect(session).toContain('keybind: "ctrl+`"')
    expect(session).toContain('id: "terminal.new"')
    expect(session).toContain('keybind: "ctrl+shift+`"')
    expect(context).toContain("createMemo(() => load(sdk.scope))")
    expect(context).not.toContain("load(sdk.scope, params.id)")
    expect(context).toContain("const session = currentSession()")
    expect(context).toContain("const client = sdk.client")
    expect(context).toContain("client.pty.remove({ ptyID: pty.id })")
    expect(context).not.toContain("sdk.client.pty")
    expect(context).toContain("const owner = (id: string)")
    expect(session).toContain('if (context !== "terminal") return')
    expect(session).toContain("void ensureSession()")
    expect(terminal).toContain("sdk.request.url(`/pty/${local.pty.id}/connect`)")
    expect(terminal).toContain("onOpenSearch")
    expect(terminal).toContain("export const preloadTerminal")
    expect(terminal).toContain("void write(t.getSelection())")
    expect(terminal).toContain("t.selectAll()")
  })

  test("keeps terminal styling local, semantic, and deliberately light", async () => {
    const [css, globalCss] = await Promise.all([read("../atlas/TerminalSurface.css"), read("../styles/atlas.css")])

    expect(css).toContain(".terminal-surface__error button")
    expect(css).toContain("font-weight: var(--font-weight-medium)")
    expect(css).toContain("background: var(--color-bg)")
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(globalCss).not.toContain(".terminal-surface")
    for (const selector of ["terminal-surface", "terminal-surface__search", "terminal-surface__tabs-row"]) {
      expect(css.match(new RegExp(`^\\.${selector} \\{`, "gm"))).toHaveLength(1)
    }
  })

  test("keeps existing terminals closable while authority only gates new process creation", async () => {
    const surface = await read("../atlas/TerminalSurface.tsx")

    expect(surface).toContain('useExecutionAuthority("terminal")')
    expect(surface).toContain("disabled={!available() || state.starting || !authority.allowed()}")
    expect(surface).toContain("disabled={state.starting || !authority.allowed()}")
    expect(surface).toContain("terminal.close(pty.id)")
    expect(surface).not.toContain(
      "disabled={!authority.allowed()}\n                      onClick={() => void terminal.close",
    )
  })
})
