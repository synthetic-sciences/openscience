import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("seamless workspace shell", () => {
  test("aligns workspace chrome while giving the navigation rail a stable project grip", async () => {
    const [header, tabs, pane, sidebar] = await Promise.all([
      read("../pages/session-header.css"),
      read("../pages/session-tabs.css"),
      read("./right-pane-tabs.css"),
      read("../pages/session-sidebar.css"),
    ])

    expect(header).toMatch(/\.workspace-header\.g-strip\s*\{[^}]*height: 44px;[^}]*flex: 0 0 44px;/s)
    expect(tabs).toMatch(/\.workspace-session-tabs\s*\{[^}]*height: 44px;/s)
    expect(pane).toMatch(/\.research-inspector__header\s*\{[^}]*height: 44px;[^}]*flex: 0 0 44px;/s)
    expect(sidebar).toMatch(/\.session-sidebar__top\s*\{[^}]*height: 50px;[^}]*flex: 0 0 50px;/s)
  })

  test("uses only structural pane separators and quiet pill tabs", async () => {
    const [tabs, pane, sidebar] = await Promise.all([
      read("../pages/session-tabs.css"),
      read("./right-pane-tabs.css"),
      read("../pages/session-sidebar.css"),
    ])

    expect(sidebar).toMatch(
      /\.session-sidebar\s*\{[^}]*border-right: 1px solid color-mix\(in srgb, var\(--color-border\) 60%, transparent\);/s,
    )
    expect(pane).toMatch(/\.session-right-pane\s*\{[^}]*border-left: 1px solid var\(--color-border\);/s)
    expect(sidebar).toMatch(/\.session-sidebar__context-actions\s*\{[^}]*border: 0;/s)
    expect(tabs).toMatch(/\.workspace-session-tab\s*\{[^}]*border: 0;/s)
    expect(pane).toMatch(/\.inspector-tab-pair\s*\{[^}]*border: 0;/s)
    expect(pane).not.toContain("color-mix")
  })

  test("keeps controls comfortably targeted with restrained feedback", async () => {
    const [tabs, pane, sidebar, source] = await Promise.all([
      read("../pages/session-tabs.css"),
      read("./right-pane-tabs.css"),
      read("../pages/session-sidebar.css"),
      read("./RightPane.tsx"),
    ])

    for (const css of [tabs, pane, sidebar]) {
      expect(css).toContain("min-height: 32px")
      expect(css).toContain("140ms var(--agent-ease)")
      expect(css).toContain("@media (pointer: coarse)")
      expect(css).toContain("min-height: 44px")
      expect(css).toContain(":active")
      expect(css).toContain("scale(")
    }
    expect(source).toMatch(/role="tablist"\s+aria-orientation="horizontal"/)
  })
})
