import { expect, test } from "bun:test"

const [source, action, tabs, css, workspaceCss] = await Promise.all([
  Bun.file(new URL("./session.tsx", import.meta.url)).text(),
  Bun.file(new URL("./session-sidebar-action.tsx", import.meta.url)).text(),
  Bun.file(new URL("./session-tabs.tsx", import.meta.url)).text(),
  Bun.file(new URL("./session-sidebar.css", import.meta.url)).text(),
  Bun.file(new URL("../styles/atlas.css", import.meta.url)).text(),
])

test("keeps the research rail readable with one stylesheet owner", () => {
  expect(source).not.toContain('class="session-sidebar__group-label"')
  expect(action).toContain('class="session-sidebar__group-label"')
  expect(action).not.toContain('"font-size":')
  expect(css).toContain(".session-sidebar__action-copy strong")
  expect(css).toContain("font-size: 12.5px")
  expect(css).toContain(".session-sidebar__empty")
  expect(css).toContain(".session-sidebar__session-status")
  expect(css).toContain(".session-sidebar__session-dot")
  expect(css).toContain('.session-sidebar__session[data-active="true"]')
  expect(css).toContain("grid-template-columns: minmax(0, 1fr)")
  expect(css).toContain("border-right: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent)")
  expect(css).toMatch(/\.session-sidebar\[data-collapsed="true"\] \.session-sidebar__list\s*\{\s*display: none;/s)
  expect(css).toMatch(
    /\.session-sidebar\[data-collapsed="true"\][^{]*\.session-sidebar__primary-actions[^{]*\.session-sidebar__action[^{]*\.session-sidebar__action-copy,?[\s\S]*?\{\s*display: none;/,
  )
  expect(css).toMatch(
    /\.session-sidebar\[data-collapsed="true"\] \.session-sidebar__project\s*\{[^}]*grid-template-columns: 1fr;/s,
  )
  expect(css).toContain("width: var(--session-sidebar-collapsed-width, 56px)")
  expect(css).toContain("content: attr(data-tooltip)")
  expect(action).toContain("data-tooltip={props.label}")
  expect(css).toContain("@media (pointer: coarse)")
  expect(workspaceCss).not.toContain(".session-sidebar")
})

test("keeps sidebar actions identifiable and gives top session tabs the tab semantics", () => {
  expect(source).toContain('aria-label={`Session actions for ${props.session.title || "Session"}`}')
  expect(source).toContain("if (restoreFocus) queueMicrotask(() => tab?.focus())")
  expect(source).toContain("commit(true)")
  expect(source).toContain("cancel(true)")
  expect(source).toContain('aria-current={props.active ? "page" : undefined}')
  expect(tabs).toContain('role="tablist"')
  expect(tabs).toContain('role="tab"')
  expect(tabs).toContain('aria-orientation="horizontal"')
})
