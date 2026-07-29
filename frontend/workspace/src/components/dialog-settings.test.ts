import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

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
