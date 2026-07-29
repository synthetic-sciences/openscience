import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./SkillsPage.tsx", import.meta.url)), "utf8")

test("skills use a compact searchable list instead of a card dashboard", () => {
  const page = source()

  expect(page).toContain('class="skills-workspace"')
  expect(page).toContain('class="skills-workspace__header"')
  expect(page).toContain('class="skills-workspace__list"')
  expect(page).toContain('class="skills-workspace__row"')
  expect(page).not.toContain("SkillCard")
  expect(page).not.toContain('"grid-template-columns": "repeat(auto-fill')
})
