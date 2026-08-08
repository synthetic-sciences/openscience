import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SETTINGS_PANELS } from "./settings/registry"

const source = () => readFileSync(fileURLToPath(new URL("./dialog-settings.tsx", import.meta.url)), "utf8")

test("settings use a compact responsive navigation frame", () => {
  const dialog = source()

  expect(dialog).toContain('class="settings-layout"')
  expect(dialog).toContain('class="settings-nav"')
  expect(dialog).toContain('class="settings-nav__sections')
  expect(dialog).toContain('class="settings-nav__item')
  expect(dialog).toContain("@media (max-width: 720px)")
  expect(dialog).not.toContain("w-[224px]")
})

test("settings enforce one sentence-case typography system", () => {
  const dialog = source()

  expect(dialog).toContain(".settings-dialog {")
  expect(dialog).toContain("font-family: var(--font-family-sans)")
  expect(dialog).toContain(".settings-section-label")
  expect(dialog).toContain("text-transform: none")
  expect(dialog).toMatch(/\.settings-nav__item\s*\{[^}]*min-height: 34px/s)
  expect(dialog).toMatch(/\.settings-nav__item\s*\{[^}]*font-size: 13px/s)
  expect(dialog).toMatch(/\.settings-nav__item\s*\{[^}]*font-weight: 500/s)
  expect(dialog).toContain('size="small"')
  expect(dialog).toContain('class="settings-main__title"')
  expect(dialog).not.toContain("text-14-medium text-text-strong truncate pl-1")
})

test("settings dialog makes every registered capability navigable", () => {
  const dialog = source()
  const skills = SETTINGS_PANELS.find((panel) => panel.id === "skills")

  expect(skills?.title).toBe("Skills")
  expect(dialog).toContain("SETTINGS_PANELS.filter((p) => p.section === section.id)")
  expect(dialog).toContain("onClick={() => navigate(panel.id)}")
  expect(dialog).toContain('aria-current={current().id === panel.id ? "page" : undefined}')
  expect(dialog).toContain("<Dynamic component={current().component} />")
})
